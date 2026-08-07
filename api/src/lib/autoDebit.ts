import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  autoDebitAttempts, documents, payments, paymentSettings, subscriptions, events,
} from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';
import { decryptSecret } from './secretbox.js';
import { chargeToken, type PayfastCreds } from './payfast.js';

/**
 * Charging a saved card on a schedule.
 *
 * This is the only thing Klippy does that takes money with nobody watching, so the
 * guards matter more than the feature. In order:
 *
 *  1. Three switches have to be on: PayFast enabled, auto-debit enabled for the
 *     account, and auto-debit agreed for that individual subscription. A client
 *     paying one invoice online has not agreed to a standing debit, and in South
 *     Africa that arrangement needs their mandate.
 *  2. There has to be a stored token, which only exists if they paid online at
 *     least once through a link that asked for one.
 *  3. The amount has to be at or under the account's cap. A wrong price or a
 *     stray zero should stop here, not at the client's bank.
 *  4. An attempt row is written BEFORE PayFast is called, with a unique index on
 *     the invoice. A second run on the same invoice hits a duplicate key and
 *     stops. Double-charging is much worse than not charging, because getting the
 *     money back costs trust as well as time.
 *  5. Nothing is charged at all until live mode is switched on. Dry run does every
 *     step except the call itself and writes down what it would have taken, which
 *     is how the client list and the amounts get proven before a cent moves.
 *
 * Every outcome is recorded in `events` next to the PayFast notifications, so the
 * whole money path is readable from one screen.
 */

export type DebitOutcome = 'charged' | 'dry-run' | 'skipped' | 'failed';

async function note(
  accountId: number, businessId: number | null, outcome: DebitOutcome, detail: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    accountId, businessId, name: 'payfast.autodebit',
    payload: { outcome, detail, ...extra },
    results: [{ handler: 'payfast.autodebit', outcome: detail, ok: outcome === 'charged' || outcome === 'dry-run' }],
  }).catch(() => { /* diagnostics must never break a billing run */ });
}

export interface DebitRequest {
  accountId: number;
  businessId: number;
  subscriptionId: number;
  documentId: number;
  /** In the account currency, e.g. 1150.00 rand. Converted to cents for PayFast. */
  amount: number;
  itemName: string;
  invoiceNumber: string;
}

export async function attemptAutoDebit(r: DebitRequest): Promise<{ outcome: DebitOutcome; detail: string }> {
  const done = async (outcome: DebitOutcome, detail: string, extra: Record<string, unknown> = {}) => {
    await note(r.accountId, r.businessId, outcome, detail, {
      subscriptionId: r.subscriptionId, documentId: r.documentId,
      number: r.invoiceNumber, amount: r.amount.toFixed(2), ...extra,
    });
    return { outcome, detail };
  };

  const [settings] = await db.select().from(paymentSettings)
    .where(eq(paymentSettings.accountId, r.accountId)).limit(1);
  if (!settings?.enabled) return { outcome: 'skipped', detail: 'PayFast is off for this account.' };
  if (!settings.autoDebitEnabled) return { outcome: 'skipped', detail: 'Auto-debit is off for this account.' };

  const [sub] = await db.select().from(subscriptions)
    .where(tenantWhere(subscriptions, r.accountId, eq(subscriptions.id, r.subscriptionId))).limit(1);
  if (!sub) return { outcome: 'skipped', detail: 'Subscription no longer exists.' };
  if (!sub.autoDebit) return { outcome: 'skipped', detail: 'This subscription is not set to auto-debit.' };
  if (!sub.payfastToken) {
    return done('skipped', 'No saved card yet. The client has to pay one invoice online before a card can be stored.');
  }

  const cap = Number(settings.autoDebitMax);
  if (r.amount > cap) {
    return done('skipped',
      `Refused: ${r.amount.toFixed(2)} is over the ${cap.toFixed(2)} per-charge limit. Raise the limit in Settings > Payments if this is correct.`,
      { cap: cap.toFixed(2) });
  }

  // The claim: this invoice has not been attempted before. The unique index on
  // documentId is what enforces it, so a concurrent run loses the race rather than
  // charging alongside us.
  try {
    await db.insert(autoDebitAttempts).values(withTenant(r.accountId, {
      subscriptionId: r.subscriptionId, documentId: r.documentId,
      status: 'pending' as const, amount: r.amount.toFixed(2),
    }));
  } catch {
    return { outcome: 'skipped', detail: 'Already attempted for this invoice.' };
  }

  const finish = async (status: 'charged' | 'failed' | 'dry-run', detail: string, pfPaymentId?: string) => {
    await db.update(autoDebitAttempts).set({ status, detail, pfPaymentId: pfPaymentId ?? null })
      .where(tenantWhere(autoDebitAttempts, r.accountId, eq(autoDebitAttempts.documentId, r.documentId)));
  };

  if (!settings.autoDebitLive) {
    await finish('dry-run', `Would have charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}.`);
    return done('dry-run',
      `Dry run: would have charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}. Nothing was taken. Switch on live charging when this list looks right.`);
  }

  if (!settings.merchantId || !settings.merchantKeyEnc) {
    await finish('failed', 'PayFast credentials are incomplete.');
    return done('failed', 'PayFast credentials are incomplete.');
  }
  const creds: PayfastCreds = {
    merchantId: settings.merchantId,
    merchantKey: decryptSecret(settings.merchantKeyEnc) ?? '',
    passphrase: settings.passphraseEnc ? decryptSecret(settings.passphraseEnc) : null,
    sandbox: settings.sandbox,
  };

  // Cents, not rands. Rounded once, here, so the amount charged is exactly the
  // amount written down on the attempt.
  const cents = Math.round(r.amount * 100);
  const res = await chargeToken(creds, sub.payfastToken, cents, r.itemName, `doc-${r.documentId}`);

  if (!res.ok) {
    await finish('failed', res.message);
    return done('failed', res.message);
  }

  // Record the money. PayFast also sends an ITN for this charge; that handler is
  // idempotent on the PayFast payment id, so whichever arrives second does nothing.
  const today = new Date().toISOString().slice(0, 10);
  await db.insert(payments).values(withTenant(r.accountId, {
    documentId: r.documentId, amount: r.amount.toFixed(2), paidOn: today,
    method: 'PayFast', note: res.pfPaymentId ? `PayFast ${res.pfPaymentId}` : 'PayFast auto-debit',
    createdBy: null,
  }));
  const paidRows = await db.select({ amount: payments.amount }).from(payments)
    .where(tenantWhere(payments, r.accountId, eq(payments.documentId, r.documentId)));
  const paid = paidRows.reduce((s, p) => s + Number(p.amount), 0);
  const [doc] = await db.select({ total: documents.total, status: documents.status }).from(documents)
    .where(tenantWhere(documents, r.accountId, eq(documents.id, r.documentId))).limit(1);
  if (doc && paid + 0.001 >= Number(doc.total) && doc.status !== 'paid') {
    await db.update(documents).set({ status: 'paid' })
      .where(tenantWhere(documents, r.accountId, eq(documents.id, r.documentId)));
  }

  await finish('charged', `Charged ${r.amount.toFixed(2)}.`, res.pfPaymentId);
  return done('charged', `Charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}.`, { pfPaymentId: res.pfPaymentId });
}

/** Recent auto-debit attempts for an account, newest first. */
export async function recentAttempts(accountId: number, limit = 20) {
  return db.select().from(autoDebitAttempts)
    .where(and(eq(autoDebitAttempts.accountId, accountId)))
    .orderBy(autoDebitAttempts.id)
    .limit(limit);
}
