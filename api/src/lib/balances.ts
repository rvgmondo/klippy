import { eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, payments } from '../db/schema.js';
import { tenantWhere } from './tenant.js';

/**
 * What is still owed on a document.
 *
 * One place, because there were two: the staff document list batched its lookups
 * into two grouped queries, and the portal ran a pair of queries PER ROW. A client
 * with a hundred invoices was costing two hundred round trips to render one page,
 * and on shared-hosting MySQL that is the difference between a page and a wait.
 *
 * Outstanding is the face value less what has been paid and less any credit note
 * raised against it. A voided credit note does not count, since voiding it is how
 * you undo one.
 */
export interface Balance { paid: number; credited: number; outstanding: number }

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Balances for many documents in two queries, whatever the number of documents.
 * Returns a map keyed by document id; a document with no payments and no credits
 * is absent, so read it with a default rather than assuming a hit.
 */
export async function balancesFor(
  accountId: number, docs: { id: number; total: string | number }[],
): Promise<Map<number, Balance>> {
  const out = new Map<number, Balance>();
  if (!docs.length) return out;
  const ids = docs.map((d) => d.id);

  const payRows = await db.select({
    documentId: payments.documentId, amount: sql<string>`SUM(${payments.amount})`,
  }).from(payments)
    .where(tenantWhere(payments, accountId, inArray(payments.documentId, ids)))
    .groupBy(payments.documentId);

  const credRows = await db.select({
    sourceDocumentId: documents.sourceDocumentId, amount: sql<string>`SUM(${documents.total})`,
  }).from(documents)
    .where(tenantWhere(documents, accountId,
      eq(documents.type, 'credit_note'),
      inArray(documents.sourceDocumentId, ids),
      ne(documents.status, 'void')))
    .groupBy(documents.sourceDocumentId);

  const paidBy = new Map<number, number>();
  for (const p of payRows) paidBy.set(p.documentId, Number(p.amount));
  const creditedBy = new Map<number, number>();
  for (const c of credRows) if (c.sourceDocumentId != null) creditedBy.set(c.sourceDocumentId, Number(c.amount));

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
export async function balanceOf(accountId: number, docId: number, total: number): Promise<Balance> {
  const map = await balancesFor(accountId, [{ id: docId, total }]);
  return map.get(docId) ?? { paid: 0, credited: 0, outstanding: round(total) };
}
