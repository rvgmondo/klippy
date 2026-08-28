import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  autoDebitAttempts, documents, folders, payments, subscriptions, events,
} from '../db/schema.js';
import { settingsFor } from './paymentSettings.js';
import { payfastSupports } from './currency.js';
import { settleIfCovered } from './settle.js';
import { notifyAdmins } from './notify.js';
import { isDuplicateKey, tenantWhere, withTenant } from './tenant.js';
import { decryptSecret } from './secretbox.js';
import { chargeToken, type PayfastCreds } from './payfast.js';

/**
 * Charging a saved card on a schedule.
 *
 * This is the only thing Klippy does that takes money with nobody watching, so the
 * guards matter more than the feature. In order:
 *
 *  1. Three switches have to be on: PayFast enabled, auto-debit enabled for the
 *     business, and auto-debit agreed for that individual subscription. A client
 *     paying one invoice online has not agreed to a standing debit, and in South
 *     Africa that arrangement needs their mandate.
 *  2. There has to be a stored token, which only exists if they paid online at
 *     least once through a link that asked for one.
 *  3. The amount has to be at or under the business's cap. A wrong price or a
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
  /** In `currency`, e.g. 1150.00 rand. Converted to cents for PayFast. */
  amount: number;
  /** The invoice's own currency. PayFast settles rand only, so this is a rail. */
  currency: string;
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

  // Per business, so a subscription is charged through the merchant account that
  // business actually banks into.
  // Rail zero: PayFast takes rand. Sending it a dollar amount would not fail, it
  // would charge the number as rand and report success, which is the worst
  // possible outcome for something that runs unattended.
  if (!payfastSupports(r.currency)) {
    return done('skipped', `PayFast cannot charge ${r.currency}. This invoice has to be collected another way.`);
  }

  const settings = await settingsFor(r.accountId, r.businessId);
  if (!settings?.enabled) return { outcome: 'skipped', detail: 'PayFast is not set up for this business.' };
  if (!settings.autoDebitEnabled) return { outcome: 'skipped', detail: 'Auto-debit is off for this business.' };

  const [sub] = await db.select().from(subscriptions)
    .where(tenantWhere(subscriptions, r.accountId, eq(subscriptions.id, r.subscriptionId))).limit(1);
  if (!sub) return { outcome: 'skipped', detail: 'Subscription no longer exists.' };
  if (!sub.autoDebit) return { outcome: 'skipped', detail: 'This subscription is not set to auto-debit.' };
  if (!sub.payfastToken) {
    return done('skipped', 'No saved card yet. The client has to pay one invoice online before a card can be stored.');
  }
  // Charging the saved card of a client the founder has deleted is the worst version
  // of this whole feature. The biller gates on it too; this file is where every other
  // guard lives, so it is stated here as well. Refused BEFORE the attempt row is
  // claimed, so a restore does not then meet "already attempted for this invoice".
  const [client] = await db.select({ id: folders.id }).from(folders)
    .where(tenantWhere(folders, r.accountId, eq(folders.id, sub.folderId), isNull(folders.deletedAt))).limit(1);
  if (!client) return done('skipped', 'This client is in the Trash, so nothing was charged.');

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
  } catch (err) {
    if (isDuplicateKey(err)) {
      // Recorded rather than returned silently. This branch is also what a STUCK
      // attempt looks like on the next run (a row left pending because a previous
      // run died mid-charge), and that is exactly the case somebody needs to see.
      return done('skipped', 'Already attempted for this invoice.');
    }
    // Anything else means the claim never landed, so nothing was charged and a
    // later run should try again. Saying "already attempted" here would send
    // somebody hunting for a charge that was never made.
    return done('failed', `Could not record the attempt, so nothing was charged: ${
      err instanceof Error ? err.message : String(err)}`);
  }

  const finish = async (status: 'charged' | 'failed' | 'dry-run', detail: string, pfPaymentId?: string) => {
    await db.update(autoDebitAttempts).set({ status, detail, pfPaymentId: pfPaymentId ?? null })
      .where(tenantWhere(autoDebitAttempts, r.accountId, eq(autoDebitAttempts.documentId, r.documentId)));
  };

  /**
   * Nothing is charged, and nothing is RECORDED, unless this is real money.
   *
   * Sandbox was the dangerous half. chargeToken talks to whichever PayFast the
   * credentials point at, so with sandbox on and live charging armed it came back
   * successful, a payment row was written and the invoice was marked paid: Klippy
   * would show a client as having settled an invoice they had never been charged
   * for. A test gateway must never be able to write real money into the books.
   */
  if (!settings.autoDebitLive || settings.sandbox) {
    const why = settings.sandbox
      ? `Sandbox mode is on, so nothing was charged and nothing was recorded. Would have taken ${r.amount.toFixed(2)} for ${r.invoiceNumber}.`
      : `Dry run: would have charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}. Nothing was taken. Switch on live charging when this list looks right.`;
    await finish('dry-run', why);
    return done('dry-run', why);
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

  /**
   * Record the money, keyed on PayFast's own payment id.
   *
   * PayFast also sends an ITN for this charge, and that handler dedupes on
   * `pf_payment_id`. This insert used to leave that column NULL and put the id in
   * the note instead, and MySQL allows unlimited NULLs in a unique index, so the two
   * rows never collided: one charge, two payment rows, the invoice showing twice the
   * money and a negative outstanding. Writing the id is what makes the claimed
   * idempotency actually true.
   *
   * A duplicate here means the ITN beat us to it, which is a normal race and not a
   * failure: fall through and settle, rather than raising an alarm for money that is
   * already correctly recorded. And when the gateway gives us no id we still write
   * the row, because `chargeToken` sends no notify_url: if we left it to an ITN that
   * may never arrive, the card would be debited with nothing recorded anywhere, and a
   * payment nobody can see is worse than one recorded twice.
   */
  const today = new Date().toISOString().slice(0, 10);
  try {
    await db.insert(payments).values(withTenant(r.accountId, {
      documentId: r.documentId, amount: r.amount.toFixed(2), paidOn: today,
      method: 'PayFast', pfPaymentId: res.pfPaymentId ?? null,
      note: res.pfPaymentId ? `PayFast ${res.pfPaymentId}` : 'PayFast auto-debit',
      createdBy: null,
    }));
  } catch (err) {
    if (!isDuplicateKey(err)) {
      // The card WAS charged and we could not write it down. Say so loudly: the
      // attempt row is closed as charged (the money did move), and the owners are
      // told to reconcile it by hand against the PayFast dashboard.
      await finish('charged', `Charged ${r.amount.toFixed(2)} but the payment could not be recorded. Check this invoice against PayFast.`, res.pfPaymentId);
      await notifyAdmins(r.accountId, {
        kind: 'payment',
        title: `Charged but not recorded: ${r.invoiceNumber}`,
        body: `Auto-debit took ${r.amount.toFixed(2)} for ${r.invoiceNumber} and Klippy could not save the payment. Check it against your PayFast dashboard.`,
        url: '/?v=billing',
      });
      return done('failed', `Charged ${r.amount.toFixed(2)} but could not record the payment: ${
        err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Settle through the shared rule, so a credit note counts here exactly as it does
  // on the pay link and in the webhook. The hand-rolled sum this replaces ignored
  // credit notes, so it could flip an invoice to paid, and provision what was sold,
  // on less money than was actually due.
  const [doc] = await db.select({ total: documents.total, status: documents.status }).from(documents)
    .where(tenantWhere(documents, r.accountId, eq(documents.id, r.documentId))).limit(1);
  if (doc) {
    const { bal } = await settleIfCovered(r.accountId, r.documentId, Number(doc.total), doc.status);
    // Charging a card for an invoice somebody had already settled by hand takes real
    // money the client does not owe. The charge stands (it happened), but nobody was
    // told, so it is said here where the rest of the money trail is read.
    if (bal.outstanding < -0.01) {
      await notifyAdmins(r.accountId, {
        kind: 'payment',
        title: `${r.invoiceNumber} has been overpaid`,
        body: `Auto-debit charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}, which is now paid more than it asks for. Check whether it was already settled, and refund the difference.`,
        url: '/?v=billing',
      });
    }
  }

  await finish('charged', `Charged ${r.amount.toFixed(2)}.`, res.pfPaymentId);
  return done('charged', `Charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}.`, { pfPaymentId: res.pfPaymentId });
}

