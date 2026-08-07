import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, businesses } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
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
        .where(tenantWhere(documents, accountId, eq(documents.type, type), businessId == null ? sql `business_id IS NULL` : eq(documents.businessId, businessId)));
    const highestUsed = Number(row?.m ?? 0);
    const start = business?.[START_COLUMN[type]] ?? null;
    // The start is a floor, never a rewind: an existing document always wins.
    const seq = Math.max(highestUsed + 1, start ?? 1);
    const prefix = prefixFor(business, type);
    return { seq, number: formatNumber(prefix, seq), prefix, highestUsed };
}
//# sourceMappingURL=numbering.js.map