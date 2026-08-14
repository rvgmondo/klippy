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
import { and, eq, type SQL, type Column } from 'drizzle-orm';

type HasAccount = { accountId: Column };

/**
 * Combine the mandatory `accountId = ?` predicate with any additional
 * conditions. Use as the `.where(...)` of every tenant-scoped select/update/delete.
 *
 *   db.select().from(clients).where(tenantWhere(clients, accountId, eq(clients.id, id)))
 */
export function tenantWhere<T extends HasAccount>(
  table: T,
  accountId: number,
  ...extra: Array<SQL | undefined>
): SQL {
  const conds = [eq(table.accountId, accountId), ...extra.filter(Boolean)] as SQL[];
  return conds.length === 1 ? conds[0]! : (and(...conds) as SQL);
}

/**
 * Stamp accountId onto a row (or rows) before insert, so callers can't omit it.
 *
 *   db.insert(clients).values(withTenant(accountId, { name, color }))
 */
export function withTenant<V extends Record<string, unknown>>(
  accountId: number,
  values: V,
): V & { accountId: number };
export function withTenant<V extends Record<string, unknown>>(
  accountId: number,
  values: V[],
): Array<V & { accountId: number }>;
export function withTenant<V extends Record<string, unknown>>(
  accountId: number,
  values: V | V[],
): (V & { accountId: number }) | Array<V & { accountId: number }> {
  return Array.isArray(values)
    ? values.map((v) => ({ ...v, accountId }))
    : { ...values, accountId };
}

/**
 * Was this a unique-constraint violation, rather than anything else?
 *
 * Several places insert a row deliberately expecting it to fail when one already
 * exists: it is how "charge this invoice once" and "one hosting account per
 * subscription" are enforced by the database rather than by a check-then-act race.
 *
 * Catching every error there and reporting "already done" is a lie when the real
 * cause was a dropped connection. It is a harmless lie for correctness, since no
 * row was written either way, but it sends whoever is reading the log looking in
 * completely the wrong place.
 */
export function isDuplicateKey(err: unknown): boolean {
  // Drizzle wraps driver errors in a DrizzleQueryError, so the MySQL code is on
  // `cause`, not on the error itself. Checking only the top level looked right and
  // was false for every real duplicate, which would have turned every idempotency
  // guard in the app into a reported failure. Both levels are checked, and the
  // chain is walked, so another wrapper layer later does not silently break it.
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const c = e as { code?: string; errno?: number; cause?: unknown };
    if (c.code === 'ER_DUP_ENTRY' || c.errno === 1062) return true;
    e = c.cause;
  }
  return false;
}
