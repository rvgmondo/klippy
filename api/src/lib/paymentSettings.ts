import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentSettings, businesses } from '../db/schema.js';
import { decryptSecret } from './secretbox.js';
import { payfastSupports } from './currency.js';
import type { PayfastCreds } from './payfast.js';

/**
 * Which PayFast account gets the money for a given business.
 *
 * One rule, in one place, because every path that moves money has to agree on it:
 * the checkout link, the public pay page, the notification handler and auto-debit.
 * If two of them resolved this differently, a client could pay one merchant account
 * while the invoice was reconciled against another.
 *
 * The rule: if the business has its own row, that row wins outright, including when
 * it is switched off. A business that has deliberately disabled online payment
 * should not quietly start taking money through the workspace gateway instead.
 * Only a business with no row of its own falls back to the workspace default
 * (businessId 0).
 */
export type Row = typeof paymentSettings.$inferSelect;

export async function settingsFor(accountId: number, businessId: number | null): Promise<Row | null> {
  if (businessId) {
    const [own] = await db.select().from(paymentSettings)
      .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, businessId)))
      .limit(1);
    if (own) return own;
  }
  const [fallback] = await db.select().from(paymentSettings)
    .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, 0)))
    .limit(1);
  return fallback ?? null;
}

/** Where a business's settings actually come from, for showing in the UI. */
export async function scopeOf(accountId: number, businessId: number): Promise<'own' | 'workspace' | 'none'> {
  const [own] = await db.select({ id: paymentSettings.id }).from(paymentSettings)
    .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, businessId)))
    .limit(1);
  if (own) return 'own';
  const [ws] = await db.select({ id: paymentSettings.id }).from(paymentSettings)
    .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, 0)))
    .limit(1);
  return ws ? 'workspace' : 'none';
}

/**
 * Usable, decrypted credentials for this business, or null. Null covers every
 * reason equally on purpose: not set up, switched off, a currency PayFast cannot
 * settle, or a rotated PAYMENTS_SECRET that can no longer decrypt what is stored.
 * None of them should take a payment.
 */
export async function credsFor(
  accountId: number, businessId: number | null, currency?: string | null,
): Promise<PayfastCreds | null> {
  // PayFast settles rand only. Checking here rather than at each call site means
  // every path that could take money (pay link, public pay page, portal checkout,
  // auto-debit) is closed by one line: PayFast would otherwise happily charge the
  // number as rand, so a $200 invoice becomes a R200 payment and the invoice is
  // marked settled.
  if (currency !== undefined && !payfastSupports(currency)) return null;
  const row = await settingsFor(accountId, businessId);
  if (!row || !row.enabled || !row.merchantId || !row.merchantKeyEnc) return null;
  try {
    return {
      merchantId: row.merchantId,
      merchantKey: decryptSecret(row.merchantKeyEnc),
      passphrase: row.passphraseEnc ? decryptSecret(row.passphraseEnc) : null,
      sandbox: row.sandbox,
    };
  } catch {
    return null;
  }
}

/**
 * Whether clients can pay online for real, in test mode only, or not at all, across the
 * given businesses (every business in the workspace when none are named).
 *
 * Resolved through settingsFor for each business, so it answers with the gateway that
 * would actually be USED. Reading payment_settings rows directly counted rows that are
 * not in effect: a deleted business's row, or a workspace row that a business's own
 * switched-off row overrides.
 *
 * `test` matters because Sandbox is on by default and the setup screen says to leave it
 * on for a trial run. An owner who never switches it off sends every client a Pay online
 * button that opens PayFast's TEST checkout, and a payment made there is recorded as
 * real and marks the invoice paid, with no money moved.
 */
export async function gatewayModeFor(
  accountId: number, businessIds?: number[],
): Promise<{ live: boolean; test: boolean }> {
  const ids = businessIds ?? (await db.select({ id: businesses.id }).from(businesses)
    .where(eq(businesses.accountId, accountId))).map((b) => b.id);
  // A workspace with no business yet still has the workspace gateway.
  const rows = await Promise.all((ids.length ? ids : [null]).map((id) => settingsFor(accountId, id)));
  const usable = rows.filter((r): r is Row => !!r?.enabled && !!r.merchantId && !!r.merchantKeyEnc);
  return { live: usable.some((r) => !r.sandbox), test: usable.some((r) => r.sandbox) };
}
