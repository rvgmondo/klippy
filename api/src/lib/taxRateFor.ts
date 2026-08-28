import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, businesses } from '../db/schema.js';

/**
 * The VAT rate a given business raises invoices at.
 *
 * Same rule as currencyFor: the business wins if it has one, otherwise the
 * workspace default, otherwise nothing. Two paths already resolved this by hand and
 * a third (the subscription biller) skipped it entirely and wrote a hardcoded zero,
 * so every recurring invoice went out with no VAT on it while the same work
 * invoiced by hand carried the full rate.
 *
 * `??` and not `||`, deliberately: a business that has explicitly set 0.00 is
 * telling us it does not charge VAT, and must not inherit the workspace rate. Only
 * an unset (null) rate falls through.
 *
 * Read once when a document is created and then copied onto it, for the same reason
 * currencyFor is: registering for VAT next year must not restate last year's
 * invoices at a rate nobody was charged.
 */
export async function taxRateFor(accountId: number, businessId: number | null): Promise<number> {
  if (businessId) {
    const [b] = await db.select({ rate: businesses.defaultTaxRate }).from(businesses)
      .where(and(eq(businesses.accountId, accountId), eq(businesses.id, businessId))).limit(1);
    if (b?.rate != null) return Number(b.rate);
  }
  const [a] = await db.select({ rate: accounts.defaultTaxRate }).from(accounts)
    .where(eq(accounts.id, accountId)).limit(1);
  return Number(a?.rate ?? 0);
}
