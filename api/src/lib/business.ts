import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, folders } from '../db/schema.js';
import { tenantWhere } from './tenant.js';

/**
 * Resolve which business a new record belongs to. Prefer the id the client sent
 * (validated against the account); otherwise fall back to the account's first
 * business so nothing is ever left unassigned. Returns null only if the account
 * somehow has no business at all.
 */
export async function resolveBusinessId(accountId: number, businessId?: number | null): Promise<number | null> {
  if (businessId) {
    const [biz] = await db.select({ id: businesses.id }).from(businesses)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1);
    if (biz) return biz.id;
  }
  const [first] = await db.select({ id: businesses.id }).from(businesses)
    .where(tenantWhere(businesses, accountId)).orderBy(asc(businesses.position)).limit(1);
  return first?.id ?? null;
}

/**
 * Which business a new invoice or quote comes from.
 *
 * resolveBusinessId falls back to the first business, which is harmless for a task
 * and wrong for money: with "All businesses" showing, an invoice for a Mondo Hosting
 * client went out on the Mondobase letterhead, with Mondobase's numbering and bank
 * details. So for documents the order is: the business that was chosen, else the
 * client's own business, else the only business there is. With several and nothing
 * to go on it refuses, and the editor asks.
 */
export async function businessForDocument(
  accountId: number, businessId: number | null | undefined, folderId: number | null | undefined,
  ask = 'Which business is this from? Pick one, so it goes out with the right letterhead, numbering and bank details.',
): Promise<{ id: number } | { error: string }> {
  if (businessId) {
    const [biz] = await db.select({ id: businesses.id }).from(businesses)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1);
    if (biz) return { id: biz.id };
  }
  if (folderId) {
    const [f] = await db.select({ businessId: folders.businessId }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
    if (f?.businessId) return { id: f.businessId };
  }
  const all = await db.select({ id: businesses.id }).from(businesses)
    .where(tenantWhere(businesses, accountId)).orderBy(asc(businesses.position)).limit(2);
  if (all.length === 1) return { id: all[0]!.id };
  if (!all.length) return { error: 'There is no business to send this from yet. Add one in Settings first.' };
  return { error: ask };
}

/** The same rule for everything else that belongs to one business's books. */
export const businessForNew = (
  accountId: number, businessId: number | null | undefined, folderId: number | null | undefined,
) => businessForDocument(accountId, businessId, folderId,
  'Which business is this for? Pick one, so it lands in the right books.');
