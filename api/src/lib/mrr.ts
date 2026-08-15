import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, businesses, offerings, subscriptions } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
import { DEFAULT_CURRENCY, roundMoney } from './currency.js';

/**
 * Monthly recurring revenue: what clients are actually signed up to pay.
 *
 * This used to sum the OFFERINGS catalogue, counting each recurring offering once
 * and ignoring subscriptions entirely, which made it a reading of the price list
 * rather than the business. Ten clients on one 7,500 retainer reported 7,500.
 * Nobody on it at all still reported 7,500. Pausing a client moved nothing. It was
 * the number on the dashboard, so it was the number people were steering by.
 *
 * Three things it now gets right:
 *
 *  1. It counts SUBSCRIPTIONS, so ten clients on a retainer is ten times the money
 *     and a cancelled client is gone from it.
 *  2. It uses the price that client actually pays, falling back to the offering's
 *     list price when nothing was negotiated.
 *  3. It normalises to a month. An annual subscription is a twelfth of its price
 *     per month, not the whole thing; counting a 30,000 annual plan as 30,000 MRR
 *     overstates the business by a factor of twelve.
 *
 * Only `active` counts. Paused and cancelled are not recurring revenue, whatever
 * we hope they will be again.
 *
 * Grouped by currency, and never converted, for the same reason as everywhere else:
 * dollars added to rand is not money in either.
 */
export async function mrrByCurrency(
  accountId: number,
  filters: (SQL | undefined)[] = [],
): Promise<{ currency: string; mrr: number; subscriptions: number }[]> {
  const rows = await db.select({
    price: subscriptions.price,
    listPrice: offerings.price,
    intervalMonths: subscriptions.intervalMonths,
    businessId: subscriptions.businessId,
  }).from(subscriptions)
    .innerJoin(offerings, eq(offerings.id, subscriptions.offeringId))
    .where(tenantWhere(subscriptions, accountId, eq(subscriptions.status, 'active'), ...filters));

  if (!rows.length) return [];

  // One lookup for the currencies involved, rather than a join that would have to
  // reach the account for the fallback anyway.
  const bizIds = [...new Set(rows.map((r) => r.businessId))];
  const bizRows = await db.select({ id: businesses.id, currency: businesses.currency })
    .from(businesses)
    .where(and(tenantWhere(businesses, accountId), inArray(businesses.id, bizIds)));
  const [acc] = await db.select({ currency: accounts.currency }).from(accounts)
    .where(eq(accounts.id, accountId)).limit(1);
  const workspace = acc?.currency || DEFAULT_CURRENCY;
  const currencyOf = new Map(bizRows.map((b) => [b.id, b.currency || workspace]));

  const bucket = new Map<string, { mrr: number; subscriptions: number }>();
  for (const r of rows) {
    const cur = currencyOf.get(r.businessId) || workspace;
    // A negotiated price wins; otherwise the offering's list price.
    const charged = Number(r.price ?? r.listPrice);
    if (!Number.isFinite(charged)) continue;
    const perMonth = charged / Math.max(1, r.intervalMonths);
    const b = bucket.get(cur) ?? { mrr: 0, subscriptions: 0 };
    b.mrr += perMonth;
    b.subscriptions += 1;
    bucket.set(cur, b);
  }

  return [...bucket]
    .map(([currency, b]) => ({
      currency,
      mrr: roundMoney(b.mrr, currency),
      subscriptions: b.subscriptions,
    }))
    .sort((a, b) => b.mrr - a.mrr);
}

/**
 * What one subscription bills each cycle: the negotiated price, or the list price.
 *
 * The one place that rule lives, because the invoice generator, the MRR figure and
 * the screen that shows a client what they pay all have to agree on it. Note this
 * is the CYCLE amount, not a monthly one: an annual subscription bills its whole
 * year at once, and only the MRR figure divides it down.
 */
export function chargeFor(
  sub: { price: string | number | null },
  offering: { price: string | number },
): number {
  return Number(sub.price ?? offering.price);
}
