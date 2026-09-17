import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentSettings, businesses, accounts } from '../db/schema.js';
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
 * Resolved the way settingsFor resolves one business (its own row wins, otherwise the
 * workspace row), but in memory from one read of each table: this runs on every Home and
 * every Billing, and a query per business was 1 + 2N of them.
 *
 * "Usable" is the same test credsFor applies before taking a payment, because a step that
 * ticks while the pay link refuses to open is worse than no step: enabled, a merchant id,
 * a key that still decrypts under the current PAYMENTS_SECRET, and a currency PayFast can
 * settle.
 *
 * `test` matters because Sandbox is on by default and the setup screen says to leave it on
 * for a trial run. An owner who never switches it off sends every client a Pay online
 * button that opens PayFast's TEST checkout, and a payment made there is recorded as real
 * and marks the invoice paid, with no money moved. `testLabel` and `testScope` say which
 * business is in test mode and whether the gateway is its own or the workspace one, so the
 * setup card can point at the screen that can actually fix it.
 */
export interface GatewayMode {
  live: boolean;
  test: boolean;
  testLabel: string | null;
  testScope: 'own' | 'workspace' | null;
}

export async function gatewayModeFor(accountId: number, businessIds?: number[]): Promise<GatewayMode> {
  const [rows, bizRows, [acct]] = await Promise.all([
    db.select().from(paymentSettings).where(eq(paymentSettings.accountId, accountId)),
    db.select({ id: businesses.id, name: businesses.name, currency: businesses.currency })
      .from(businesses).where(eq(businesses.accountId, accountId)),
    db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1),
  ]);
  const workspaceRow = rows.find((r) => r.businessId === 0) ?? null;
  const wanted = businessIds ? bizRows.filter((b) => businessIds.includes(b.id)) : bizRows;
  // A workspace with no business of its own still has the workspace gateway.
  const targets = wanted.length
    ? wanted
    : (businessIds ? [] : [{ id: 0, name: null, currency: null }]);

  const usable = (row: Row | null, currency: string | null | undefined): boolean => {
    if (!row?.enabled || !row.merchantId || !row.merchantKeyEnc) return false;
    if (!payfastSupports(currency ?? acct?.currency)) return false;
    try { decryptSecret(row.merchantKeyEnc); } catch { return false; }
    return true;
  };

  const out: GatewayMode = { live: false, test: false, testLabel: null, testScope: null };
  for (const b of targets) {
    const own = b.id ? rows.find((r) => r.businessId === b.id) ?? null : null;
    const row = own ?? workspaceRow;
    if (!usable(row, b.currency)) continue;
    if (row!.sandbox) {
      out.test = true;
      if (!out.testScope) {
        out.testLabel = b.name;
        out.testScope = own ? 'own' : 'workspace';
      }
    } else {
      out.live = true;
    }
  }
  return out;
}
