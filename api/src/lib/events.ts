import { db } from '../db/client.js';
import { events } from '../db/schema.js';

/**
 * A small pub/sub hub, so the modules can cause things to happen in each other
 * without knowing about each other.
 *
 * The value of a business operating system is not that it stores four kinds of
 * record; it is that closing a deal creates the work, drafts the invoice and tells
 * the team, without anyone remembering to. That means Acquisition has to reach into
 * Fulfillment and Finance, and wiring those together directly would knot every
 * module to every other one. Instead a module announces what happened and whoever
 * cares responds.
 *
 * Two deliberate properties:
 *  - A failing handler never takes down the others, or the request that emitted the
 *    event. Drafting an invoice failing must not cost you the client's board.
 *  - Every emission is written to `events` with each handler's outcome, because an
 *    automation you cannot see is one you cannot trust.
 */

export type EventName = 'deal.won';

export interface EventContext {
  accountId: number;
  userId: number | null;
}

export interface HandlerResult { outcome: string; ok: boolean; data?: Record<string, unknown> }

type Handler<P> = (payload: P, ctx: EventContext) => Promise<HandlerResult>;

interface Registered { name: string; run: Handler<never> }

const registry = new Map<EventName, Registered[]>();

/** Register a handler. Handlers run in registration order. */
export function on<P>(event: EventName, name: string, run: Handler<P>): void {
  const list = registry.get(event) ?? [];
  list.push({ name, run: run as Handler<never> });
  registry.set(event, list);
}

export interface EmitResult {
  results: { handler: string; outcome: string; ok: boolean }[];
  /** Merged `data` from every handler, so the caller can use what they produced. */
  data: Record<string, unknown>;
}

/**
 * Announce that something happened. Always resolves: handler failures are captured
 * as results rather than thrown, since the caller's own work already succeeded.
 */
export async function emit<P extends Record<string, unknown>>(
  event: EventName, payload: P, ctx: EventContext & { businessId?: number | null },
): Promise<EmitResult> {
  const handlers = registry.get(event) ?? [];
  const results: { handler: string; outcome: string; ok: boolean }[] = [];
  const data: Record<string, unknown> = {};

  for (const h of handlers) {
    try {
      const r = await (h.run as Handler<P>)(payload, ctx);
      results.push({ handler: h.name, outcome: r.outcome, ok: r.ok });
      if (r.data) Object.assign(data, r.data);
    } catch (err) {
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
  } catch { /* ignore */ }

  return { results, data };
}

/** Test seam: drop all handlers. */
export function resetHandlers(): void {
  registry.clear();
}
