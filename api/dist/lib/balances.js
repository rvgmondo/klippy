import { eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, payments } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
const round = (n) => Math.round(n * 100) / 100;
/**
 * Balances for many documents in two queries, whatever the number of documents.
 * Returns a map keyed by document id; a document with no payments and no credits
 * is absent, so read it with a default rather than assuming a hit.
 */
export async function balancesFor(accountId, docs) {
    const out = new Map();
    if (!docs.length)
        return out;
    const ids = docs.map((d) => d.id);
    const payRows = await db.select({
        documentId: payments.documentId, amount: sql `SUM(${payments.amount})`,
    }).from(payments)
        .where(tenantWhere(payments, accountId, inArray(payments.documentId, ids)))
        .groupBy(payments.documentId);
    const credRows = await db.select({
        sourceDocumentId: documents.sourceDocumentId, amount: sql `SUM(${documents.total})`,
    }).from(documents)
        .where(tenantWhere(documents, accountId, eq(documents.type, 'credit_note'), inArray(documents.sourceDocumentId, ids), ne(documents.status, 'void')))
        .groupBy(documents.sourceDocumentId);
    const paidBy = new Map();
    for (const p of payRows)
        paidBy.set(p.documentId, Number(p.amount));
    const creditedBy = new Map();
    for (const c of credRows)
        if (c.sourceDocumentId != null)
            creditedBy.set(c.sourceDocumentId, Number(c.amount));
    for (const d of docs) {
        const paid = paidBy.get(d.id) ?? 0;
        const credited = creditedBy.get(d.id) ?? 0;
        out.set(d.id, {
            paid: round(paid),
            credited: round(credited),
            outstanding: round(Number(d.total) - paid - credited),
        });
    }
    return out;
}
/** The same answer for one document, when that is genuinely all you need. */
export async function balanceOf(accountId, docId, total) {
    const map = await balancesFor(accountId, [{ id: docId, total }]);
    return map.get(docId) ?? { paid: 0, credited: 0, outstanding: round(total) };
}
//# sourceMappingURL=balances.js.map