import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentConnections, sales } from '../db/schema.js';
import { isDuplicateKey, tenantWhere, withTenant } from './tenant.js';
import { decryptSecret } from './secretbox.js';
import { taxRateFor } from './taxRateFor.js';
import { currencyFor } from './currencyFor.js';
import { roundMoney } from './currency.js';
import { windows } from './yoco.js';
import { providerFor } from './salesProviders.js';
/** How far back a first-ever sync reaches. Far enough to be useful, not a decade. */
const FIRST_SYNC_DAYS = 90;
/** Re-read a few days each run: a provider can settle or adjust a sale after the fact. */
const OVERLAP_DAYS = 3;
const dayString = (d) => d.toISOString().slice(0, 10);
const shift = (iso, days) => {
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
export function taxOutOf(gross, rate, currency) {
    if (!(rate > 0))
        return 0;
    return roundMoney(gross * (rate / (100 + rate)), currency);
}
export async function syncProvider(accountId, businessId, providerKey = 'yoco', opts = {}) {
    const provider = providerFor(providerKey);
    if (!provider?.client) {
        return { ok: false, added: 0, updated: 0, message: `Klippy cannot read takings from ${provider?.label ?? providerKey} yet.` };
    }
    const [conn] = await db.select().from(paymentConnections)
        .where(tenantWhere(paymentConnections, accountId, eq(paymentConnections.businessId, businessId), eq(paymentConnections.provider, providerKey)))
        .limit(1);
    if (!conn)
        return { ok: false, added: 0, updated: 0, message: `${provider.label} is not connected for this business.` };
    if (!conn.enabled)
        return { ok: false, added: 0, updated: 0, message: `The ${provider.label} connection is switched off.` };
    if (!conn.secretEnc)
        return { ok: false, added: 0, updated: 0, message: `There is no ${provider.label} key stored.` };
    let secret;
    try {
        secret = decryptSecret(conn.secretEnc);
    }
    catch {
        return { ok: false, added: 0, updated: 0, message: `The stored ${provider.label} key could not be read. Enter it again.` };
    }
    const today = dayString(new Date());
    const from = opts.fullResync || !conn.lastSyncedThrough
        ? shift(today, -FIRST_SYNC_DAYS)
        : shift(conn.lastSyncedThrough, -OVERLAP_DAYS);
    const rate = await taxRateFor(accountId, businessId);
    const currency = await currencyFor(accountId, businessId);
    let added = 0;
    let updated = 0;
    let reachedThrough = null;
    for (const w of windows(from, today)) {
        let cursor;
        // Bounded: 200 pages of 100 is 20,000 sales in one window, far past a real month.
        for (let page = 0; page < 200; page++) {
            const res = await provider.client.listPayments(secret, { from: w.from, to: w.to, cursor });
            if (!res.ok) {
                // Stop at the failure and keep the ground already covered, so the next run
                // resumes from there instead of starting the whole pull again.
                await finish(conn.id, accountId, reachedThrough, res.message);
                return { ok: false, added, updated, message: res.message };
            }
            for (const p of res.data.payments) {
                // A cancelled or failed tap is not money and has no business in the books.
                if (p.status && !['approved', 'succeeded', 'successful'].includes(p.status.toLowerCase()))
                    continue;
                const gross = roundMoney(p.gross, p.currency || currency);
                const fee = roundMoney(p.fee, p.currency || currency);
                const values = {
                    businessId,
                    provider: providerKey,
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
                }
                catch (err) {
                    if (!isDuplicateKey(err))
                        throw err;
                    // Seen before. Refresh it rather than skipping: a refund or a settled fee
                    // can land on a sale days after the tap, and the second read is the truer
                    // one. The figures are the provider's either way.
                    await db.update(sales).set({
                        fee: values.fee, net: values.net, refunded: values.refunded,
                        status: values.status, taxAmount: values.taxAmount,
                    }).where(tenantWhere(sales, accountId, eq(sales.provider, providerKey), eq(sales.externalId, p.id)));
                    updated++;
                }
            }
            cursor = res.data.nextCursor ?? undefined;
            if (!cursor)
                break;
        }
        reachedThrough = w.to;
    }
    const message = `${added} new, ${updated} updated.`;
    await finish(conn.id, accountId, reachedThrough ?? today, message);
    return { ok: true, added, updated, message };
}
async function finish(id, accountId, through, status) {
    await db.update(paymentConnections).set({
        lastSyncedAt: new Date(),
        ...(through ? { lastSyncedThrough: through } : {}),
        lastStatus: status.slice(0, 255),
    }).where(tenantWhere(paymentConnections, accountId, eq(paymentConnections.id, id)))
        .catch(() => { });
}
/** Every connected business, for the nightly run. */
export async function syncAllConnections() {
    const rows = await db.select({
        accountId: paymentConnections.accountId, businessId: paymentConnections.businessId,
        provider: paymentConnections.provider,
    }).from(paymentConnections).where(eq(paymentConnections.enabled, true));
    let ok = 0;
    let failed = 0;
    let added = 0;
    for (const r of rows) {
        // A connection to a provider with no client written yet is skipped in silence
        // rather than counted as a failure: nothing is broken, it just is not built.
        if (!providerFor(r.provider)?.client)
            continue;
        try {
            const res = await syncProvider(r.accountId, r.businessId, r.provider);
            if (res.ok) {
                ok++;
                added += res.added;
            }
            else
                failed++;
        }
        catch {
            // One broken connection must not stop the rest; the reason is already stored
            // against that connection by finish().
            failed++;
        }
    }
    return `${ok} connection(s) synced, ${added} new sale(s)${failed ? `, ${failed} failed` : ''}`;
}
//# sourceMappingURL=salesSync.js.map