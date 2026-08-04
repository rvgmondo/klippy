import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { type AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { db } from '../db/client.js';
import { businessMembers, businesses } from '../db/schema.js';
import { authOf } from './context.js';

/**
 * Per-business access control.
 *
 * Account owners and admins see and manage every business (they run the account).
 * A plain member sees only the businesses they have a `business_members` row for,
 * with the role recorded there. This module is the single place that answers "which
 * businesses can this request touch, and may it write to this one".
 *
 * The accessible-set is resolved once per request and cached on `req`, so scoping a
 * handful of list endpoints does not cost a query each.
 */

export type BusinessRole = 'admin' | 'member' | 'viewer';

interface AccessCache { all: boolean; ids: Set<number>; roles: Map<number, BusinessRole> }

declare module 'fastify' {
  interface FastifyRequest { _access?: AccessCache }
}

async function loadAccess(req: FastifyRequest): Promise<AccessCache> {
  if (req._access) return req._access;
  const { accountId, userId, role } = authOf(req);
  // Owners and admins implicitly get everything.
  if (role === 'owner' || role === 'admin') {
    req._access = { all: true, ids: new Set(), roles: new Map() };
    return req._access;
  }
  const rows = await db.select({ businessId: businessMembers.businessId, role: businessMembers.role })
    .from(businessMembers)
    .where(and(eq(businessMembers.accountId, accountId), eq(businessMembers.userId, userId)));
  const ids = new Set<number>();
  const roles = new Map<number, BusinessRole>();
  for (const r of rows) { ids.add(r.businessId); roles.set(r.businessId, r.role); }
  req._access = { all: false, ids, roles };
  return req._access;
}

/** True if this request may see every business (account owner/admin). */
export async function seesAllBusinesses(req: FastifyRequest): Promise<boolean> {
  return (await loadAccess(req)).all;
}

/**
 * The set of business ids this request may touch, or null for "all of them".
 * Callers scope their queries: `null` => no business filter, a Set => filter to it.
 */
export async function accessibleBusinessIds(req: FastifyRequest): Promise<Set<number> | null> {
  const a = await loadAccess(req);
  return a.all ? null : a.ids;
}

/** Can this request see the given business at all? */
export async function canSeeBusiness(req: FastifyRequest, businessId: number): Promise<boolean> {
  const a = await loadAccess(req);
  return a.all || a.ids.has(businessId);
}

/**
 * The request's effective role on one business: 'admin' for account owners/admins,
 * otherwise the per-business role, or null when there is no access.
 */
export async function businessRole(req: FastifyRequest, businessId: number): Promise<BusinessRole | null> {
  const a = await loadAccess(req);
  if (a.all) return 'admin';
  return a.roles.get(businessId) ?? null;
}

const RANK: Record<BusinessRole, number> = { viewer: 0, member: 1, admin: 2 };

/**
 * Guard for a route: verify access to `businessId` at `min` role or better. On
 * failure it sends the response (404 when they cannot see it at all, so its
 * existence is not revealed; 403 when they can see it but lack the role) and
 * returns false. Handlers should `if (!(await assertBusinessAccess(...))) return;`.
 */
export async function assertBusinessAccess(
  req: FastifyRequest, reply: FastifyReply, businessId: number, min: BusinessRole = 'member',
): Promise<boolean> {
  const role = await businessRole(req, businessId);
  if (!role) { await reply.code(404).send({ error: 'Business not found.' }); return false; }
  if (RANK[role] < RANK[min]) {
    await reply.code(403).send({ error: 'You do not have permission to do that in this business.' });
    return false;
  }
  return true;
}

/**
 * A WHERE condition that limits a query to the businesses this request may see,
 * for a table with a `business_id` column. Returns undefined for owners/admins (no
 * extra filter), or a `1=0` when the member has access to nothing. Drop it into an
 * existing tenant filter: `tenantWhere(t, accountId, await businessScope(req, t.businessId), ...)`.
 */
export async function businessScope(req: FastifyRequest, column: AnyMySqlColumn): Promise<SQL | undefined> {
  const allowed = await accessibleBusinessIds(req);
  if (allowed === null) return undefined;
  if (allowed.size === 0) return sql`1 = 0`;
  return inArray(column, [...allowed]);
}

/** All business ids in the account (used to expand "all" for owners/admins). */
export async function allBusinessIds(accountId: number): Promise<number[]> {
  const rows = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.accountId, accountId));
  return rows.map((r) => r.id);
}
