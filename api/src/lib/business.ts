import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses } from '../db/schema.js';
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
