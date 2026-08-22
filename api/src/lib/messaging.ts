import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { messagingSettings, folders, contacts, events } from '../db/schema.js';
import { decryptSecret } from './secretbox.js';

/**
 * Reminders by SMS and WhatsApp.
 *
 * Email reminders from a small business get ignored; a WhatsApp or SMS gets read
 * in minutes. Two layers live here:
 *
 *   1. Click-to-chat: a wa.me link with the message pre-written. Zero setup, zero
 *      cost. The founder taps and sends from their own phone.
 *   2. Automated sending: SMS through BulkSMS (South African, pay-as-you-go, a
 *      ten-minute signup) and WhatsApp through Meta's Cloud API (needs a Meta
 *      Business account and an approved template). Both behind Settings >
 *      Messaging, both off until credentials are in and a channel is switched on.
 *
 * Every automated send is recorded in the events table, success or failure, so
 * "did the reminder go?" is answered from the app rather than a provider console.
 */

// ---- Phone numbers -----------------------------------------------------------

/**
 * Normalise a typed phone number to E.164 digits (no plus): "082 123 4567"
 * becomes "27821234567". South Africa is the default country; a number that
 * already carries a country code keeps it. Returns null when nothing usable is
 * left, so callers never message a blank.
 */
export function normalizePhone(raw: string | null | undefined, defaultCc = '27'): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = defaultCc + digits.slice(1);
  digits = digits.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return digits;
}

/** The click-to-chat link: opens WhatsApp with the text already in the box. */
export function whatsappLink(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/**
 * The phone to reach a client on: the number on the client record, else the
 * first contact with a phone attached to that client. Null when neither.
 */
export async function phoneForClient(accountId: number, folderId: number | null): Promise<string | null> {
  if (!folderId) return null;
  const [f] = await db.select({ phone: folders.billingPhone }).from(folders)
    .where(and(eq(folders.accountId, accountId), eq(folders.id, folderId))).limit(1);
  const own = normalizePhone(f?.phone);
  if (own) return own;
  const [c] = await db.select({ phone: contacts.phone }).from(contacts)
    .where(and(eq(contacts.accountId, accountId), eq(contacts.folderId, folderId), isNotNull(contacts.phone)))
    .limit(1);
  return normalizePhone(c?.phone);
}

// ---- Message text ------------------------------------------------------------

export interface ReminderFacts {
  clientName: string;
  number: string;
  amount: string;        // already formatted, e.g. "ZAR 1,500.00"
  /** "is due on 2026-09-01", "was due on 2026-08-20 (3 days ago)", "is overdue" */
  whenPhrase: string;
  link: string | null;
  brand: string;
}

/** One message that reads well as an SMS, a WhatsApp, or a pre-filled chat. */
export function reminderText(f: ReminderFacts): string {
  return [
    `Hi ${f.clientName}, invoice ${f.number} for ${f.amount} ${f.whenPhrase}.`,
    f.link ? `Pay here: ${f.link}` : null,
    `If it is already paid, please ignore this. ${f.brand}`,
  ].filter(Boolean).join(' ');
}

/**
 * The five ordered variables our WhatsApp template expects: {{1}} client,
 * {{2}} invoice number, {{3}} amount, {{4}} when, {{5}} link. Documented in the
 * settings panel so the template the founder creates in Meta lines up.
 */
export function templateParams(f: ReminderFacts): string[] {
  return [f.clientName, f.number, f.amount, f.whenPhrase, f.link ?? 'your invoice'];
}

// ---- Settings resolution -----------------------------------------------------

export type MessagingRow = typeof messagingSettings.$inferSelect;

/** The business's own settings, else the workspace default (business 0). */
export async function messagingFor(accountId: number, businessId: number | null): Promise<MessagingRow | null> {
  if (businessId) {
    const [own] = await db.select().from(messagingSettings)
      .where(and(eq(messagingSettings.accountId, accountId), eq(messagingSettings.businessId, businessId))).limit(1);
    if (own) return own;
  }
  const [fallback] = await db.select().from(messagingSettings)
    .where(and(eq(messagingSettings.accountId, accountId), eq(messagingSettings.businessId, 0))).limit(1);
  return fallback ?? null;
}

/** Which automated channels are actually usable: switched on AND credentialed. */
export function channelsFor(row: MessagingRow | null): { sms: boolean; whatsapp: boolean } {
  if (!row) return { sms: false, whatsapp: false };
  return {
    sms: row.remindBySms && row.smsProvider === 'bulksms' && !!row.smsTokenId && !!row.smsTokenSecretEnc,
    whatsapp: row.remindByWhatsapp && !!row.waPhoneNumberId && !!row.waAccessTokenEnc && !!row.waTemplateName,
  };
}

// ---- Providers ---------------------------------------------------------------

/** BulkSMS JSON API: one POST, basic auth with the token pair from their console. */
export async function sendSms(row: MessagingRow, to: string, body: string): Promise<void> {
  if (row.smsProvider !== 'bulksms' || !row.smsTokenId || !row.smsTokenSecretEnc) {
    throw new Error('SMS is not configured.');
  }
  const auth = Buffer.from(`${row.smsTokenId}:${decryptSecret(row.smsTokenSecretEnc)}`).toString('base64');
  const res = await fetch('https://api.bulksms.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({
      to: `+${to}`,
      body,
      ...(row.smsSender ? { from: row.smsSender } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`BulkSMS ${res.status}: ${detail.slice(0, 200) || res.statusText}`);
  }
}

/**
 * WhatsApp Cloud API: a business-initiated message must be an approved template.
 * We send the configured template with our five variables in order.
 */
export async function sendWhatsAppTemplate(row: MessagingRow, to: string, params: string[]): Promise<void> {
  if (!row.waPhoneNumberId || !row.waAccessTokenEnc || !row.waTemplateName) {
    throw new Error('WhatsApp is not configured.');
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${row.waPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${decryptSecret(row.waAccessTokenEnc)}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: row.waTemplateName,
        language: { code: row.waTemplateLang || 'en' },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`WhatsApp ${res.status}: ${detail.slice(0, 200) || res.statusText}`);
  }
}

// ---- The one door the app uses ------------------------------------------------

export interface SendOutcome { sms?: string; whatsapp?: string }

/**
 * Send a reminder over every enabled channel. Never throws: a provider outage
 * must not stop the email reminder that rode alongside it. Outcomes are returned
 * AND recorded as an event, per channel, so the Automation panel can show them.
 */
export async function sendReminderMessage(
  accountId: number, businessId: number | null, to: string | null, facts: ReminderFacts,
  context: { kind: string; docId?: number },
): Promise<SendOutcome> {
  const out: SendOutcome = {};
  if (!to) return out;
  const row = await messagingFor(accountId, businessId);
  const ch = channelsFor(row);
  if (!ch.sms && !ch.whatsapp) return out;

  if (ch.sms) {
    try { await sendSms(row!, to, reminderText(facts)); out.sms = 'sent'; }
    catch (e) { out.sms = e instanceof Error ? e.message : 'failed'; }
  }
  if (ch.whatsapp) {
    try { await sendWhatsAppTemplate(row!, to, templateParams(facts)); out.whatsapp = 'sent'; }
    catch (e) { out.whatsapp = e instanceof Error ? e.message : 'failed'; }
  }

  await db.insert(events).values({
    accountId, businessId: businessId ?? null, name: 'messaging.send',
    payload: { kind: context.kind, docId: context.docId ?? null, to: `+${to}`, number: facts.number },
    results: [
      ...(out.sms ? [{ handler: 'sms', outcome: out.sms, ok: out.sms === 'sent' }] : []),
      ...(out.whatsapp ? [{ handler: 'whatsapp', outcome: out.whatsapp, ok: out.whatsapp === 'sent' }] : []),
    ],
  }).catch(() => { /* diagnostics never break a send */ });
  return out;
}
