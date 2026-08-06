import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businessEmail, businesses } from '../db/schema.js';
import { decryptSecret } from './secretbox.js';

/**
 * Sends mail via SMTP if configured (SMTP_HOST etc). If not configured, it
 * logs the message instead of throwing, so flows like password reset still
 * work in dev / before email is set up (the reset link appears in the log).
 */
let transport: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter | null {
  if (transport) return transport;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransport();
  const from = process.env.SMTP_FROM ?? 'Klippy <no-reply@localhost>';
  if (!t) {
    // eslint-disable-next-line no-console
    console.log(`[mailer:not-configured] would send to ${to}: ${subject}\n${text}`);
    return;
  }
  await t.sendMail({ from, to, subject, text });
}

// ---- Per-business sending ---------------------------------------------------

/** Custom SMTP transports, cached by a signature so a settings change rebuilds. */
const bizTransports = new Map<string, nodemailer.Transporter>();

/** The bare address inside a "Name <addr>" from string, for building a fallback. */
function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m?.[1] ?? from).trim();
}

type Purpose = 'invoice' | 'general';

interface Sender { from: string; replyTo: string | undefined; transport: nodemailer.Transporter | null }

/**
 * How this business's mail should be addressed and sent for a given purpose.
 * Invoice mail prefers the invoice-specific fields, then the general ones, then the
 * business brand name over the global sending address. A business with its own SMTP
 * is sent through it; otherwise the shared server.
 */
async function resolveBusinessSender(accountId: number, businessId: number, purpose: Purpose): Promise<Sender> {
  const [cfg] = await db.select().from(businessEmail)
    .where(eq(businessEmail.businessId, businessId)).limit(1);
  const [biz] = await db.select({ brandName: businesses.brandName, name: businesses.name }).from(businesses)
    .where(eq(businesses.id, businessId)).limit(1);
  const brand = biz?.brandName || biz?.name || 'Invoice';

  const inv = purpose === 'invoice';
  const name = (inv ? cfg?.invoiceFromName : null) || cfg?.fromName || brand;
  const globalAddr = addressOf(process.env.SMTP_FROM ?? 'no-reply@localhost');
  const email = (inv ? cfg?.invoiceFromEmail : null) || cfg?.fromEmail || globalAddr;
  const replyTo = (inv ? cfg?.invoiceReplyTo : null) || cfg?.replyTo || undefined;
  const from = `${name} <${email}>`;

  // Business's own SMTP, if set; else the shared transport.
  let t = getTransport();
  if (cfg?.smtpHost) {
    const sig = `${businessId}:${cfg.smtpHost}:${cfg.smtpPort}:${cfg.smtpUser}:${cfg.updatedAt?.getTime?.() ?? ''}`;
    let cached = bizTransports.get(sig);
    if (!cached) {
      const port = cfg.smtpPort ?? 587;
      cached = nodemailer.createTransport({
        host: cfg.smtpHost, port, secure: cfg.smtpSecure ?? port === 465,
        auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassEnc ? safeDecrypt(cfg.smtpPassEnc) : undefined } : undefined,
      });
      bizTransports.set(sig, cached);
    }
    t = cached;
  }
  return { from, replyTo, transport: t };
}

function safeDecrypt(enc: string): string | undefined {
  try { return decryptSecret(enc); } catch { return undefined; }
}

/**
 * Send a mail addressed as a business (invoices, quotes, reminders). Falls back to
 * logging when nothing can send, exactly like sendMail, so nothing throws for a lack
 * of configuration.
 */
export interface MailAttachment { filename: string; content: Buffer }

export async function sendBusinessMail(opts: {
  accountId: number; businessId: number | null; purpose: Purpose;
  to: string; subject: string; text: string; attachments?: MailAttachment[];
}): Promise<void> {
  // No business (legacy doc) -> the plain account sender.
  if (!opts.businessId) {
    const t = getTransport();
    if (!t) {
      // eslint-disable-next-line no-console
      console.log(`[mailer:not-configured] would send to ${opts.to}: ${opts.subject}${opts.attachments?.length ? ` (+${opts.attachments.length} attachment)` : ''}`);
      return;
    }
    await t.sendMail({
      from: process.env.SMTP_FROM ?? 'Klippy <no-reply@localhost>',
      to: opts.to, subject: opts.subject, text: opts.text, attachments: opts.attachments,
    });
    return;
  }
  const s = await resolveBusinessSender(opts.accountId, opts.businessId, opts.purpose);
  if (!s.transport) {
    // eslint-disable-next-line no-console
    console.log(`[mailer:not-configured] would send (biz ${opts.businessId}) from ${s.from}${s.replyTo ? ` reply-to ${s.replyTo}` : ''} to ${opts.to}: ${opts.subject}${opts.attachments?.length ? ` (+${opts.attachments.map((a) => a.filename).join(', ')})` : ''}`);
    return;
  }
  await s.transport.sendMail({
    from: s.from, replyTo: s.replyTo, to: opts.to, subject: opts.subject, text: opts.text,
    attachments: opts.attachments,
  });
}

export function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}
