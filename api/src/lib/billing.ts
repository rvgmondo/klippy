import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, businesses, offerings, folders } from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';
import { sendMail } from './mailer.js';
import { payLinkFor } from './paylink.js';

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * Next billing date, one month on.
 *
 * Two traps this avoids, both of which quietly cost real money:
 *  1. Naive month arithmetic OVERFLOWS: 31 Jan + 1 month becomes 3 Mar, skipping
 *     February entirely and pushing every later bill further out.
 *  2. Clamping alone STICKS: 31 Jan -> 28 Feb -> 28 Mar, so a month-end
 *     subscription silently moves to the 28th forever.
 *
 * So we clamp against the month's length but always measure from `anchorDay` (the
 * day the subscription started), which lets it spring back:
 * 31 Jan -> 28 Feb -> 31 Mar -> 30 Apr -> 31 May.
 */
export function addOneMonth(dateStr: string, anchorDay?: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const day = anchorDay ?? d;
  // First of the following month, then clamp the anchor day to that month's length.
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Day-of-month a subscription bills on, taken from the date it started. */
export function anchorDayOf(startedOn: string): number {
  return Number(startedOn.split('-')[2]);
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Turn one subscription billing cycle into an invoice, same shape as one created by
 * hand. Used when a subscription starts and by the recurring cron job.
 *
 * If the subscription is set to send itself and the client has a billing email, the
 * invoice goes out and is marked sent. Otherwise it stays a draft for review. A
 * recurring charge that still needs a human to press send every month is not really
 * recurring, which is the whole reason `autoSend` exists.
 */
export async function generateSubscriptionInvoice(accountId: number, sub: {
  businessId: number; offeringId: number; folderId: number; createdBy: number | null;
  autoSend?: boolean;
}): Promise<number> {
  const [offering] = await db.select().from(offerings)
    .where(tenantWhere(offerings, accountId, eq(offerings.id, sub.offeringId))).limit(1);
  const [folder] = await db.select().from(folders)
    .where(tenantWhere(folders, accountId, eq(folders.id, sub.folderId))).limit(1);
  if (!offering || !folder) throw new Error('Offering or client no longer exists.');

  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  // Brand the invoice email from the business it belongs to, not the account.
  const [business] = await db.select({ brandName: businesses.brandName, name: businesses.name }).from(businesses)
    .where(tenantWhere(businesses, accountId, eq(businesses.id, sub.businessId))).limit(1);
  const brand = business?.brandName || business?.name || account?.brandName || 'Invoice';
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
      clientName: folder.name, clientEmail: folder.billingEmail ?? null, clientAddress: null,
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

  // Send it, if asked to and there is somewhere to send it. A failure here must not
  // lose the invoice: it stays a draft and can be sent by hand.
  if (sub.autoSend && folder.billingEmail) {
    try {
      const payLink = await payLinkFor(accountId, docId);
      await sendMail(
        folder.billingEmail,
        `${brand} ${number}`,
        [
          `Hi ${folder.name},`,
          '',
          `Invoice ${number} for ${offering.name} is attached below.`,
          `Amount: ${currency} ${money(price)}`,
          `Due: ${dueDate}`,
          '',
          ...(payLink ? [`Pay online: ${payLink}`, ''] : []),
          'Thank you.',
        ].join('\n'),
      );
      await db.update(documents).set({ status: 'sent' })
        .where(tenantWhere(documents, accountId, eq(documents.id, docId)));
    } catch {
      // Left as a draft on purpose, so it is visible as unsent rather than lost.
    }
  }
  return docId;
}
