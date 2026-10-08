import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deals, dealActivities, documents } from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';

/**
 * Deals and the quotes made for them.
 *
 * A deal used to end at "Proposal" with nothing behind it: the quote lived in
 * Invoicing, the deal on the board, and nobody could see from one that the other
 * had moved. These two hooks are the whole link. A quote made from a deal moves the
 * deal along and says so in its history; a quote the client accepts puts the deal
 * on today's follow-up list so somebody marks it won.
 *
 * Accepting does NOT mark the deal won by itself. Winning fires the handoff, which
 * sets up a client and a draft invoice, and the accepted quote is about to become
 * that invoice anyway. Doing both would bill the client twice.
 */

const OPEN = ['lead', 'contacted', 'proposal'] as const;

/** The deal exists in this workspace. Used to refuse a dealId from another one. */
export async function dealInAccount(accountId: number, dealId: number): Promise<boolean> {
  const [d] = await db.select({ id: deals.id }).from(deals)
    .where(tenantWhere(deals, accountId, eq(deals.id, dealId))).limit(1);
  return !!d;
}

/** A quote was made for this deal: note it, and move an early deal to Proposal. */
export async function quoteMadeForDeal(
  accountId: number, dealId: number, doc: { type: string; number: string }, userId: number | null,
): Promise<void> {
  const [deal] = await db.select({ stage: deals.stage }).from(deals)
    .where(tenantWhere(deals, accountId, eq(deals.id, dealId))).limit(1);
  if (!deal) return;
  const label = doc.type === 'quote' ? 'Quote' : 'Invoice';
  const moves = doc.type === 'quote' && (deal.stage === 'lead' || deal.stage === 'contacted');
  if (moves) {
    await db.update(deals).set({ stage: 'proposal' })
      .where(tenantWhere(deals, accountId, eq(deals.id, dealId)));
  }
  await db.insert(dealActivities).values(withTenant(accountId, {
    dealId, kind: 'note' as const,
    body: moves ? `${label} ${doc.number} made, so the deal moved to proposal` : `${label} ${doc.number} made`,
    occurredAt: new Date(), createdBy: userId,
  })).catch(() => { /* history is worth having, not worth failing a quote over */ });
}

/**
 * A quote was accepted, by the client or by hand. If it was made for an open deal,
 * put that deal on today's follow-up list and remember the client it went to, so
 * marking it won reuses that client instead of making a second one.
 */
export async function quoteAccepted(accountId: number, quoteId: number, who: string | null): Promise<void> {
  const [q] = await db.select({ dealId: documents.dealId, number: documents.number, folderId: documents.folderId })
    .from(documents).where(tenantWhere(documents, accountId, eq(documents.id, quoteId))).limit(1);
  if (!q?.dealId) return;
  const [deal] = await db.select({ id: deals.id, clientFolderId: deals.clientFolderId }).from(deals)
    .where(tenantWhere(deals, accountId, and(eq(deals.id, q.dealId), inArray(deals.stage, [...OPEN])))).limit(1);
  if (!deal) return;
  await db.update(deals).set({
    nextFollowUpAt: new Date().toISOString().slice(0, 10),
    followUpNote: `Quote ${q.number} accepted. Mark the deal won.`,
    ...(!deal.clientFolderId && q.folderId ? { clientFolderId: q.folderId } : {}),
  }).where(tenantWhere(deals, accountId, eq(deals.id, deal.id)));
  await db.insert(dealActivities).values(withTenant(accountId, {
    dealId: deal.id, kind: 'note' as const,
    body: `Quote ${q.number} accepted${who ? ` by ${who}` : ''}`,
    occurredAt: new Date(), createdBy: null,
  })).catch(() => { /* as above */ });
}
