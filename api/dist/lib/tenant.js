/**
 * Tenant isolation helper.
 *
 * MySQL has no row-level security, so every query against a tenant-owned table
 * MUST be scoped by accountId in application code. To make that impossible to
 * forget, domain code should build WHERE clauses through `tenantWhere()` rather
 * than writing `eq(table.accountId, ...)` by hand, and inserts should go through
 * `withTenant()` so the accountId is always stamped on.
 *
 * Any table passed here must have an `accountId` column (all domain tables do;
 * see schema.ts).
 */
import { and, eq } from 'drizzle-orm';
/**
 * Combine the mandatory `accountId = ?` predicate with any additional
 * conditions. Use as the `.where(...)` of every tenant-scoped select/update/delete.
 *
 *   db.select().from(clients).where(tenantWhere(clients, accountId, eq(clients.id, id)))
 */
export function tenantWhere(table, accountId, ...extra) {
    const conds = [eq(table.accountId, accountId), ...extra.filter(Boolean)];
    return conds.length === 1 ? conds[0] : and(...conds);
}
export function withTenant(accountId, values) {
    return Array.isArray(values)
        ? values.map((v) => ({ ...v, accountId }))
        : { ...values, accountId };
}
//# sourceMappingURL=tenant.js.map