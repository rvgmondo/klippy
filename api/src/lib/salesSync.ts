import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentConnections, sales } from '../db/schema.js';
import { isDuplicateKey, tenantWhere, withTenant } from './tenant.js';
import { decryptSecret } from './secretbox.js';
import { taxRateFor } from './taxRateFor.js';
import { currencyFor } from './currencyFor.js';
import { roundMoney } from './currency.js';
import { listPayments, windows } from './yoco.js';

/**
 * Pulling takings in from a card machine.
 *
 * The rules this follows, in the order they matter:
 *
 *  1. NEVER RECORD THE SAME TAP TWICE. Every sale is keyed on the provider's own id
 *    behind a unique index, so a sync can run on a schedule, by hand, and twice at
 *    once, and a shop's day still adds up.
 *  2. NEVER INVENT A FIGURE. Gross, fee and tip come from the provider. VAT does not
 *    exist in their data, so it is derived from the business rate and nothing else,
 *    and a business with no rate set gets zero.
 *  3. RESUME, DO NOT RESTART. The connection remembers the last day it fully pulled,
 *    and the next run starts a day earlier than that to catch anything the provider
 *    settled late. Re-reading a day is free because of rule 1.
 *  4. SAY WHAT HAPPENED. A failed sync writes its reason where the owner can read it
 *    rather than leaving a connection that looks fine and quietly pulls nothing.
 */

export interface SyncResult {
  ok: boolean;
  added: number;
  updated: number;
  message: string;
}

/** How far back a first-ever sync reaches. Far enough to be useful, not a decade. */
const FIRST_SYNC_DAYS = 90;
/** Re-read a few days each run: a provider can settle or adjust a sale after the fact. */
const OVERLAP_DAYS = 3;

const dayString = (d: Date) => d.toISOString().slice(0, 10);
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return dayString(d);
};

/**
 * VAT out of a card sale.
 *
 * Money taken at a till is consideration RECEIVED, which the VAT Act treats as
 * inclusive of tax. So the tax is backed out of the gross rather than added on top:
 * R115 taken at 15% is R100 of revenue and R15 of output VAT, not R115 plus R17.25.
 * Getting this backwards would overstate both revenue and the VAT return.
 */
export function taxOutOf(gross: number, rate: number, currency: string): number {
  if (!(rate > 0)) return 0;
  return roundMoney(gross * (rate / (100 + rate)), currency);
}

export async function syncYoco(
  accountId: number, businessId: number, opts: { fullResync?: boolean } = {},
): Promise<SyncResult> {
  const [conn] = await db.select().from(paymentConnections)
    .where(tenantWhere(paymentConnections, accountId,
      eq(paymentConnections.businessId, businessId),
      eq(paymentConnections.provider, 'yoco')))
    .limit(1);
  if (!conn) return { ok: false, added: 0, updated: 0, message: 'Yoco is not connected for this business.' };
  if (!conn.enabled) return { ok: false, added: 0, updated: 0, message: 'The Yoco connection is switched off.' };
  if (!conn.secretEnc) return { ok: false, added: 0, updated: 0, message: 'There is no Yoco API key stored.' };

  let secret: string;
  try { secret = decryptSecret(conn.secretEnc); } catch {
    return { ok: false, added: 0, updated: 0, message: 'The stored Yoco key could not be read. Enter it again.' };
  }

  const today = dayString(new Date());
  const from = opts.fullResync || !conn.lastSyncedThrough
    ? shift(today, -FIRST_SYNC_DAYS)
    : shift(conn.lastSyncedThrough, -OVERLAP_DAYS);

  const rate = await taxRateFor(accountId, businessId);
  const currency = await currencyFor(accountId, businessId);

  let added = 0;
  let updated = 0;
  let reachedThrough: string | null = null;

  for (const w of windows(from, today)) {
    let cursor: string | undefined;
    // Bounded: 200 pages of 100 is 20,000 sales in one window, far past a real month.
    for (let page = 0; page < 200; page++) {
      const res = await listPayments(secret, { from: w.from, to: w.to, cursor });
      if (!res.ok) {
        // Stop at the failure and keep the ground already covered, so the next run
        // resumes from there instead of starting the whole pull again.
        await finish(conn.id, accountId, reachedThrough, res.message);
        return { ok: false, added, updated, message: res.message };
      }

      for (const p of res.data.payments) {
        // A cancelled or failed tap is not money and has no business in the books.
        if (p.status && !['approved', 'succeeded', 'successful'].includes(p.status.toLowerCase())) continue;

        const gross = roundMoney(p.gross, p.currency || currency);
        const fee = roundMoney(p.fee, p.currency || currency);
        const values = {
          businessId,
          provider: 'yoco' as const,
          externalId: p.id,
          source: p.source,
          terminal: p.cardMachineId,
          occurredAt: new Date(p.createdAt),
          currency: p.currency || currency,
          gross: gross.toFixed(2),
          fee: fee.toFixed(2),
          net: roundMoney(gross - fee, p.currency || currency).toFixed(2),
          tip: roundMoney(p.tip, p.currency || currency).toFixed(2),
          refunded: roundMoney(p.refunded, p.currency || currency).toFixed(2),
          taxRate: rate.toFixed(2),
          taxAmount: taxOutOf(gross, rate, p.currency || currency).toFixed(2),
          status: p.status,
          reference: p.reference,
        };

        try {
          await db.insert(sales).values(withTenant(accountId, values));
          added++;
        } catch (err) {
          if (!isDuplicateKey(err)) throw err;
          // Seen before. Refresh it rather than skipping: a refund or a settled fee
          // can land on a sale days after the tap, and the second read is the truer
          // one. The figures are the provider's either way.
          await db.update(sales).set({
            fee: values.fee, net: values.net, refunded: values.refunded,
            status: values.status, taxAmount: values.taxAmount,
          }).where(tenantWhere(sales, accountId,
            eq(sales.provider, 'yoco'), eq(sales.externalId, p.id)));
          updated++;
        }
      }

      cursor = res.data.nextCursor ?? undefined;
      if (!cursor) break;
    }
    reachedThrough = w.to;
  }

  const message = `${added} new, ${updated} updated.`;
  await finish(conn.id, accountId, reachedThrough ?? today, message);
  return { ok: true, added, updated, message };
}

async function finish(
  id: number, accountId: number, through: string | null, status: string,
): Promise<void> {
  await db.update(paymentConnections).set({
    lastSyncedAt: new Date(),
    ...(through ? { lastSyncedThrough: through } : {}),
    lastStatus: status.slice(0, 255),
  }).where(tenantWhere(paymentConnections, accountId, eq(paymentConnections.id, id)))
    .catch(() => { /* the sync itself already stands */ });
}

/** Every connected business, for the nightly run. */
export async function syncAllConnections(): Promise<string> {
  const rows = await db.select({
    accountId: paymentConnections.accountId, businessId: paymentConnections.businessId,
  }).from(paymentConnections).where(and(eq(paymentConnections.enabled, true), eq(paymentConnections.provider, 'yoco')));

  let ok = 0;
  let failed = 0;
  let added = 0;
  for (const r of rows) {
    try {
      const res = await syncYoco(r.accountId, r.businessId);
      if (res.ok) { ok++; added += res.added; } else failed++;
    } catch {
      // One broken connection must not stop the rest; the reason is already stored
      // against that connection by finish().
      failed++;
    }
  }
  return `${ok} connection(s) synced, ${added} new sale(s)${failed ? `, ${failed} failed` : ''}`;
}
