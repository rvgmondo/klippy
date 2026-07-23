import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
/** Parse a positive integer route param, or null if invalid. */
export function intId(req, key = 'id') {
    const raw = req.params[key];
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}
/** Next append position (max+1) within a scope. Pass the already-built WHERE. */
export async function nextPosition(table, where) {
    const rows = (await db
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .select({ m: sql `COALESCE(MAX(${table.position}), -1)` })
        .from(table)
        .where(where));
    return Number(rows[0]?.m ?? -1) + 1;
}
//# sourceMappingURL=http.js.map