import { eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, businesses } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
/**
 * Document numbering.
 *
 * Two things people expect and Klippy did not offer: their own prefix (a lot of
 * businesses have used "MB-" or "2026/" for years and their clients recognise it),
 * and control of where the count is. The second matters most when moving from
 * another system, where restarting at 0001 next to invoices already numbered 1042
 * is a bookkeeping mess.
 *
 * The next number is always `max(highest used + 1, start)`. Deriving from the
 * highest used means a raised start can never collide with a document that already
 * exists, and lowering the start quietly does nothing rather than issuing a
 * duplicate number.
 */
/**
 * Where documents brought over from another system are numbered.
 *
 * They keep the number they were issued under (the text a client recognises),
 * but their sequence sits far above anything Klippy will ever issue, so two
 * things hold without a schema change: an old "MB-10408" never collides with
 * Klippy's own 10408, and importing history never moves where Klippy's count
 * carries on from. The same line marks them as history for the reminder job,
 * which never chases them on its own; the Chase button still works.
 */
export const IMPORTED_SEQ_BASE = 3_000_000_000;
export const isImportedSeq = (seq) => seq >= IMPORTED_SEQ_BASE;
const FALLBACK_PREFIX = {
    quote: 'QUO-', invoice: 'INV-', credit_note: 'CN-',
};
const PREFIX_COLUMN = {
    quote: 'prefixQuote', invoice: 'prefixInvoice', credit_note: 'prefixCreditNote',
};
const START_COLUMN = {
    quote: 'seqStartQuote', invoice: 'seqStartInvoice', credit_note: 'seqStartCreditNote',
};
export function prefixFor(business, type) {
    const custom = business?.[PREFIX_COLUMN[type]];
    return (custom ?? '').trim() || FALLBACK_PREFIX[type];
}
/** Format a sequence the way it appears on a document. */
export function formatNumber(prefix, seq) {
    return `${prefix}${String(seq).padStart(4, '0')}`;
}
/**
 * The next sequence and number for a business + type, without consuming it.
 * Used both when issuing a document and to show "your next invoice will be X".
 */
export async function nextNumberFor(accountId, businessId, type) {
    const [business] = businessId
        ? await db.select().from(businesses)
            .where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1)
        : [undefined];
    const [row] = await db.select({ m: sql `COALESCE(MAX(seq),0)` }).from(documents)
        .where(tenantWhere(documents, accountId, eq(documents.type, type), lt(documents.seq, IMPORTED_SEQ_BASE), businessId == null ? sql `business_id IS NULL` : eq(documents.businessId, businessId)));
    const highestUsed = Number(row?.m ?? 0);
    const start = business?.[START_COLUMN[type]] ?? null;
    // The start is a floor, never a rewind: an existing document always wins.
    const seq = Math.max(highestUsed + 1, start ?? 1);
    const prefix = prefixFor(business, type);
    return { seq, number: formatNumber(prefix, seq), prefix, highestUsed };
}
//# sourceMappingURL=numbering.js.map