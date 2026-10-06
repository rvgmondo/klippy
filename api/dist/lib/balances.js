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
/**
 * The least an invoice can still owe before anything chases it.
 *
 * Status alone said who to chase, and status only turns to "paid" when the money
 * recorded covers the total to the cent. A client who paid R287 on an R287.50
 * invoice, or an invoice part-paid and settled by a credit note, stayed "sent" and
 * was chased for the full amount by email, SMS and WhatsApp. Every automatic
 * reminder, notice and suspension now asks the balance, and a remainder under one
 * unit of the currency (rounding, a bank fee) is never worth a reminder.
 */
export const CHASE_MIN = 1;
//# sourceMappingURL=balances.js.map