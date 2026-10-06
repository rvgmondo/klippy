import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, invoiceReminders } from '../db/schema.js';
import { withTenant } from './tenant.js';
import { addDays } from './billing.js';

/**
 * When an invoice will be chased next, and why not.
 *
 * One function, used by the daily reminder run AND by the screens that say "next
 * reminder 13 Oct". If the screen worked it out separately it would sooner or
 * later promise one date while the run sent on another, which is exactly the kind
 * of surprise this exists to remove.
 */

export const DEFAULT_REMINDER_OFFSETS = [-3, 0, 7];

export interface ReminderConfig { enabled: boolean; offsets: number[]; suspendAfter: number | null; brand: string }

export async function reminderConfigFor(businessId: number | null): Promise<ReminderConfig> {
  if (businessId == null) return { enabled: true, offsets: DEFAULT_REMINDER_OFFSETS, suspendAfter: null, brand: 'Accounts' };
  const [b] = await db.select({
    remindersEnabled: businesses.remindersEnabled, reminderOffsets: businesses.reminderOffsets,
    suspendAfterDays: businesses.suspendAfterDays, brandName: businesses.brandName, name: businesses.name,
  }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return {
    enabled: b?.remindersEnabled ?? true,
    offsets: b?.reminderOffsets && b.reminderOffsets.length ? b.reminderOffsets : DEFAULT_REMINDER_OFFSETS,
    suspendAfter: b?.suspendAfterDays ?? null,
    brand: b?.brandName || b?.name || 'Accounts',
  };
}

export interface ReminderPlan {
  /** The day the next one goes out (today when one is already due), or null. */
  next: string | null;
  /** What it will be: a reminder, or the final "service at risk" notice. */
  kind: 'reminder' | 'final' | null;
  /** Why there is none, in words for the screen. */
  reason: string | null;
  /** Whether it was moved by hand. */
  moved: boolean;
}

const none = (reason: string): ReminderPlan => ({ next: null, kind: null, reason, moved: false });

export function planReminder(
  doc: {
    status: string; type?: string; dueDate: string | null; lastReminderOn: string | null; suspendedAt: Date | string | null;
    remindersPaused: boolean; nextReminderOn: string | null;
  },
  cfg: ReminderConfig,
  opts: { today: string; clientPaused?: boolean; owing: number; imported?: boolean; chaseMin: number },
): ReminderPlan {
  if (doc.type && doc.type !== 'invoice') return none('Only invoices are chased.');
  if (doc.status === 'paid') return none('Paid. Nothing to chase.');
  if (doc.status === 'void') return none('Cancelled.');
  if (doc.status === 'draft') return none('Not sent yet, so nothing is chased.');
  if (opts.owing < opts.chaseMin) return none('Nothing left to pay.');
  if (opts.imported) return none('Brought over from your old system. Never chased automatically; use Chase yourself.');
  if (doc.remindersPaused) return none('Paused for this invoice.');
  if (opts.clientPaused) return none('Paused for this client.');
  if (!cfg.enabled) return none('Reminders are off for this business.');
  if (!doc.dueDate) return none('It has no due date.');

  const finalOn = cfg.suspendAfter != null && !doc.suspendedAt ? addDays(doc.dueDate, cfg.suspendAfter) : null;
  const kindOn = (d: string): 'reminder' | 'final' => (finalOn && d >= finalOn ? 'final' : 'reminder');

  // Moved by hand: that date, whatever the schedule says.
  if (doc.nextReminderOn) {
    const d = doc.nextReminderOn < opts.today ? opts.today : doc.nextReminderOn;
    return { next: d, kind: kindOn(d), reason: null, moved: true };
  }

  const last = doc.lastReminderOn;
  // Scheduled reminders after the last one sent. The final notice is not filtered
  // by the last reminder: it goes once, whenever it is reached and not yet sent.
  // Nothing goes twice in one day.
  const candidates = cfg.offsets.map((o) => addDays(doc.dueDate!, o))
    .filter((d) => !last || d > last)
    .concat(finalOn ? [finalOn] : [])
    .filter((d) => last !== opts.today || d > opts.today)
    .sort();
  const first = candidates[0];
  if (!first) return none('No more reminders on the schedule.');
  // A date already passed goes out on the next run, so it reads as today.
  const d = first < opts.today ? opts.today : first;
  return { next: d, kind: kindOn(d), reason: null, moved: false };
}

/** Write down one reminder that went out. Never throws: the send has happened. */
export async function logReminder(accountId: number, rows: {
  documentId: number; kind: 'reminder' | 'final' | 'chase'; channels: string[]; sentTo: string | null;
  amount: number | null; sentBy?: number | null;
}[]): Promise<void> {
  if (!rows.length) return;
  try {
    await db.insert(invoiceReminders).values(rows.map((r) => withTenant(accountId, {
      documentId: r.documentId, kind: r.kind, channels: r.channels.join(', ').slice(0, 60) || 'email',
      sentTo: r.sentTo?.slice(0, 150) ?? null, amount: r.amount != null ? r.amount.toFixed(2) : null,
      sentBy: r.sentBy ?? null,
    })));
  } catch { /* the record is a nicety; the reminder itself already went */ }
}

/** Which channels a send reached, from the email result and the SMS/WhatsApp outcome. */
export function channelsOf(emailed: boolean, out: { sms?: string; whatsapp?: string } | undefined): string[] {
  return [
    ...(emailed ? ['email'] : []),
    ...(out?.sms === 'sent' ? ['SMS'] : []),
    ...(out?.whatsapp === 'sent' ? ['WhatsApp'] : []),
  ];
}
