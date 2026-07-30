import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, offerings, folders } from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function addOneMonth(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Turn one subscription billing cycle into a draft invoice - same shape as a normal
 * invoice created by hand, just generated automatically. Left as a draft rather than
 * auto-sent, so whoever runs the business reviews it before it goes to the client.
 * Used both when a subscription starts (bill immediately) and by the recurring cron job.
 */
export async function generateSubscriptionInvoice(accountId: number, sub: {
  businessId: number; offeringId: number; folderId: number; createdBy: number | null;
}): Promise<number> {
  const [offering] = await db.select().from(offerings)
    .where(tenantWhere(offerings, accountId, eq(offerings.id, sub.offeringId))).limit(1);
  const [folder] = await db.select().from(folders)
    .where(tenantWhere(folders, accountId, eq(folders.id, sub.folderId))).limit(1);
  if (!offering || !folder) throw new Error('Offering or client no longer exists.');

  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const currency = account?.currency ?? 'ZAR';
  const price = Number(offering.price);
  const issueDate = new Date().toISOString().slice(0, 10);
  const dueDate = addDays(issueDate, 7);

  const [row] = await db.select({ m: sql<number>`COALESCE(MAX(seq),0)` }).from(documents)
    .where(tenantWhere(documents, accountId, eq(documents.type, 'invoice')));
  const seq = Number(row?.m ?? 0) + 1;
  const number = `INV-${String(seq).padStart(4, '0')}`;

  const docId = await db.transaction(async (tx) => {
    const ins = await tx.insert(documents).values(withTenant(accountId, {
      type: 'invoice' as const, seq, number, businessId: sub.businessId, folderId: sub.folderId,
      clientName: folder.name, clientEmail: null, clientAddress: null,
      issueDate, dueDate, currency,
      taxRate: '0', subtotal: money(price), taxAmount: '0', total: money(price),
      notes: `Auto-generated for the ${offering.name} subscription.`, createdBy: sub.createdBy,
    }));
    const newId = Number(ins[0].insertId);
    await tx.insert(documentLines).values(withTenant(accountId, {
      documentId: newId, description: `${offering.name}${offering.unit ? ` (${offering.unit})` : ''}`,
      quantity: '1.00', unitPrice: money(price), amount: money(price), position: 0,
    }));
    return newId;
  });
  return docId;
}
