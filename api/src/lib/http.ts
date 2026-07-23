import type { FastifyRequest } from 'fastify';
import { sql, type Column } from 'drizzle-orm';
import { db } from '../db/client.js';

/** Parse a positive integer route param, or null if invalid. */
export function intId(req: FastifyRequest, key = 'id'): number | null {
  const raw = (req.params as Record<string, string>)[key];
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Next append position (max+1) within a scope. Pass the already-built WHERE. */
export async function nextPosition(
  table: { position: Column },
  where: ReturnType<typeof sql>,
): Promise<number> {
  const rows = (await db
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select({ m: sql<number>`COALESCE(MAX(${table.position}), -1)` })
    .from(table as any)
    .where(where as any)) as Array<{ m: number }>;
  return Number(rows[0]?.m ?? -1) + 1;
}
