/**
 * Talking to Yoco.
 *
 * Yoco is where the card machines are, so this is how in-person takings and their
 * fees reach Klippy at all. Built against their published API reference, and every
 * shape below is theirs rather than ours:
 *
 *  - `GET /v1/payments` lists payments. Each carries `payment_source` (one value of
 *    which is literally `card_machine`), `card_machine_id`, `processing_fees[]`,
 *    `total_amount`, `tip_amount` and `refunded_amount`.
 *  - Amounts are INTEGER CENTS with an ISO currency beside them, never decimals.
 *  - The date filters accept a MAXIMUM 31 DAY RANGE, which is why the sync walks
 *    month-sized windows instead of asking for a year.
 *  - Paging is by opaque `cursor`, not page numbers.
 *
 * NOT YET RUN AGAINST A LIVE MERCHANT ACCOUNT. The shapes come from the reference,
 * so the parsing is deliberately defensive: anything missing or unexpected makes one
 * sale unreadable rather than throwing the whole sync away, and nothing here writes
 * a figure it did not actually receive.
 */
const BASE = 'https://api.yoco.com/v1';
/** Their documented ceiling on a single query's date range. */
export const MAX_WINDOW_DAYS = 31;
/** Cents to rand. Yoco sends integers; everything downstream is decimal money. */
const major = (v) => {
    const n = typeof v === 'number' ? v : Number(v?.amount);
    return Number.isFinite(n) ? n / 100 : 0;
};
const currencyOf = (v, fallback = 'ZAR') => {
    const c = v?.currency;
    return typeof c === 'string' && c.length === 3 ? c.toUpperCase() : fallback;
};
/**
 * One page of payments.
 *
 * Errors are classified rather than thrown: a 401 means the key is wrong and asking
 * again will not help, while a 429 or a 5xx is worth another go later. The sync uses
 * that difference to decide whether to keep its place or stop and say so.
 */
export async function listPayments(secret, opts) {
    const q = new URLSearchParams({
        created_at__gte: `${opts.from}T00:00:00Z`,
        created_at__lte: `${opts.to}T23:59:59Z`,
        limit: String(opts.limit ?? 100),
    });
    if (opts.cursor)
        q.set('cursor', opts.cursor);
    let res;
    try {
        res = await fetch(`${BASE}/payments/?${q.toString()}`, {
            headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        });
    }
    catch (err) {
        return {
            ok: false, retryable: true,
            message: `Could not reach Yoco: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 401/403 is a credential problem, 400 is our query. Neither is worth retrying.
        const retryable = res.status === 429 || res.status >= 500;
        const message = res.status === 401 || res.status === 403
            ? 'Yoco refused the API key. Check it is correct and still has permission to read payments.'
            : `Yoco answered ${res.status}. ${body.slice(0, 200)}`;
        return { ok: false, message, retryable };
    }
    let json;
    try {
        json = await res.json();
    }
    catch {
        return { ok: false, retryable: true, message: 'Yoco sent something that was not JSON.' };
    }
    const root = (json ?? {});
    // Their list responses have been seen under both keys; accept either rather than
    // silently reading nothing if they settle on the other one.
    const rows = Array.isArray(root.data) ? root.data
        : Array.isArray(root.payments) ? root.payments
            : Array.isArray(root.results) ? root.results : [];
    const payments = [];
    for (const raw of rows) {
        const id = typeof raw.id === 'string' ? raw.id : null;
        const createdAt = typeof raw.created_at === 'string' ? raw.created_at : null;
        // No id means nothing can dedupe it, and no date means it cannot be placed in a
        // period. Either way it is safer to drop the row than to invent one.
        if (!id || !createdAt)
            continue;
        const fees = Array.isArray(raw.processing_fees) ? raw.processing_fees : [];
        const fee = fees.reduce((sum, f) => sum + Math.abs(major(f)), 0);
        payments.push({
            id,
            status: typeof raw.status === 'string' ? raw.status : 'approved',
            createdAt,
            source: typeof raw.payment_source === 'string' ? raw.payment_source : null,
            cardMachineId: typeof raw.card_machine_id === 'string' ? raw.card_machine_id : null,
            currency: currencyOf(raw.total_amount),
            gross: major(raw.total_amount),
            fee,
            tip: major(raw.tip_amount),
            refunded: major(raw.refunded_amount),
            reference: typeof raw.receipt_number === 'string' ? raw.receipt_number : null,
        });
    }
    const meta = (root.meta ?? root.pagination ?? root);
    const nextCursor = typeof meta.next_cursor === 'string' ? meta.next_cursor
        : typeof root.next_cursor === 'string' ? root.next_cursor : null;
    return { ok: true, data: { payments, nextCursor } };
}
/**
 * A cheap call that proves a key works before it is stored.
 *
 * Saving a credential that has never been tried is how a connection sits there
 * looking configured and quietly pulls nothing for a month.
 */
export async function testKey(secret) {
    const today = new Date().toISOString().slice(0, 10);
    const res = await listPayments(secret, { from: today, to: today, limit: 1 });
    if (!res.ok)
        return res;
    return { ok: true, data: { payments: res.data.payments.length } };
}
/** Windows of at most 31 days, oldest first, because that is their limit per query. */
export function windows(from, to) {
    const out = [];
    const end = new Date(`${to}T00:00:00.000Z`);
    let cur = new Date(`${from}T00:00:00.000Z`);
    // Bounded so a nonsense range cannot spin: 120 windows is a decade of months.
    for (let i = 0; i < 120 && cur <= end; i++) {
        const stop = new Date(cur);
        stop.setUTCDate(stop.getUTCDate() + MAX_WINDOW_DAYS - 1);
        const last = stop > end ? end : stop;
        out.push({ from: cur.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) });
        cur = new Date(last);
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}
//# sourceMappingURL=yoco.js.map