import { db } from '../db/client.js';
import { events } from '../db/schema.js';
const registry = new Map();
/** Register a handler. Handlers run in registration order. */
export function on(event, name, run) {
    const list = registry.get(event) ?? [];
    list.push({ name, run: run });
    registry.set(event, list);
}
/**
 * Announce that something happened. Always resolves: handler failures are captured
 * as results rather than thrown, since the caller's own work already succeeded.
 */
export async function emit(event, payload, ctx) {
    const handlers = registry.get(event) ?? [];
    const results = [];
    const data = {};
    for (const h of handlers) {
        try {
            const r = await h.run(payload, ctx);
            results.push({ handler: h.name, outcome: r.outcome, ok: r.ok });
            if (r.data)
                Object.assign(data, r.data);
        }
        catch (err) {
            results.push({
                handler: h.name,
                outcome: err instanceof Error ? err.message : 'failed',
                ok: false,
            });
        }
    }
    // The log is a convenience, never a reason to fail the request.
    try {
        await db.insert(events).values({
            accountId: ctx.accountId,
            businessId: ctx.businessId ?? null,
            name: event,
            payload,
            results,
        });
    }
    catch { /* ignore */ }
    return { results, data };
}
/** Test seam: drop all handlers. */
export function resetHandlers() {
    registry.clear();
}
//# sourceMappingURL=events.js.map