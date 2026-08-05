import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businessMembers, businesses, boards, folders, tasks } from '../db/schema.js';
import { authOf } from './context.js';
async function loadAccess(req) {
    if (req._access)
        return req._access;
    const { accountId, userId, role } = authOf(req);
    // Owners and admins implicitly get everything.
    if (role === 'owner' || role === 'admin') {
        req._access = { all: true, ids: new Set(), roles: new Map() };
        return req._access;
    }
    const rows = await db.select({ businessId: businessMembers.businessId, role: businessMembers.role })
        .from(businessMembers)
        .where(and(eq(businessMembers.accountId, accountId), eq(businessMembers.userId, userId)));
    const ids = new Set();
    const roles = new Map();
    for (const r of rows) {
        ids.add(r.businessId);
        roles.set(r.businessId, r.role);
    }
    req._access = { all: false, ids, roles };
    return req._access;
}
/** True if this request may see every business (account owner/admin). */
export async function seesAllBusinesses(req) {
    return (await loadAccess(req)).all;
}
/**
 * The set of business ids this request may touch, or null for "all of them".
 * Callers scope their queries: `null` => no business filter, a Set => filter to it.
 */
export async function accessibleBusinessIds(req) {
    const a = await loadAccess(req);
    return a.all ? null : a.ids;
}
/** Can this request see the given business at all? */
export async function canSeeBusiness(req, businessId) {
    const a = await loadAccess(req);
    return a.all || a.ids.has(businessId);
}
/**
 * The request's effective role on one business: 'admin' for account owners/admins,
 * otherwise the per-business role, or null when there is no access.
 */
export async function businessRole(req, businessId) {
    const a = await loadAccess(req);
    if (a.all)
        return 'admin';
    return a.roles.get(businessId) ?? null;
}
const RANK = { viewer: 0, member: 1, admin: 2 };
/**
 * Guard for a route: verify access to `businessId` at `min` role or better. On
 * failure it sends the response (404 when they cannot see it at all, so its
 * existence is not revealed; 403 when they can see it but lack the role) and
 * returns false. Handlers should `if (!(await assertBusinessAccess(...))) return;`.
 */
export async function assertBusinessAccess(req, reply, businessId, min = 'member') {
    const role = await businessRole(req, businessId);
    if (!role) {
        await reply.code(404).send({ error: 'Business not found.' });
        return false;
    }
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
export async function businessScope(req, column) {
    const allowed = await accessibleBusinessIds(req);
    if (allowed === null)
        return undefined;
    if (allowed.size === 0)
        return sql `1 = 0`;
    return inArray(column, [...allowed]);
}
/** All business ids in the account (used to expand "all" for owners/admins). */
export async function allBusinessIds(accountId) {
    const rows = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.accountId, accountId));
    return rows.map((r) => r.id);
}
/**
 * Like assertBusinessAccess, but a null business (legacy/uncategorised work) is
 * allowed through, matching how the folder list treats business-less folders.
 */
export async function assertMaybeBusiness(req, reply, businessId, min = 'member') {
    if (businessId == null)
        return true;
    return assertBusinessAccess(req, reply, businessId, min);
}
// The next two resolve a board/task to its business (board -> folder, task -> board
// -> folder) and enforce access. They short-circuit for account owners/admins, so
// the common single-user case does no extra query; only scoped members pay the join.
export async function assertBoardAccess(req, reply, boardId, min = 'member') {
    if (await seesAllBusinesses(req))
        return true;
    const { accountId } = authOf(req);
    const [row] = await db.select({ businessId: folders.businessId }).from(boards)
        .innerJoin(folders, eq(folders.id, boards.folderId))
        .where(and(eq(boards.id, boardId), eq(boards.accountId, accountId))).limit(1);
    if (!row) {
        await reply.code(404).send({ error: 'Not found.' });
        return false;
    }
    return assertMaybeBusiness(req, reply, row.businessId, min);
}
export async function assertTaskAccess(req, reply, taskId, min = 'member') {
    if (await seesAllBusinesses(req))
        return true;
    const { accountId } = authOf(req);
    const [row] = await db.select({ businessId: folders.businessId }).from(tasks)
        .innerJoin(boards, eq(boards.id, tasks.boardId))
        .innerJoin(folders, eq(folders.id, boards.folderId))
        .where(and(eq(tasks.id, taskId), eq(tasks.accountId, accountId))).limit(1);
    if (!row) {
        await reply.code(404).send({ error: 'Not found.' });
        return false;
    }
    return assertMaybeBusiness(req, reply, row.businessId, min);
}
//# sourceMappingURL=access.js.map