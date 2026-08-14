import type { FastifyInstance } from 'fastify';
import { money } from '../lib/money.js';
import { z } from 'zod';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deals, dealActivities, folders, boards, boardColumns } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness } from '../lib/access.js';
import { intId, nextPosition } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';
import { emit } from '../lib/events.js';
import type { DealWonPayload } from '../lib/handoff.js';

const STAGES = ['lead', 'contacted', 'proposal', 'won', 'lost'] as const;
const stage = z.enum(STAGES);

const DEFAULT_COLUMNS = [
  { name: 'To do', color: '#94a3b8', isDoneColumn: false },
  { name: 'Doing', color: '#3b82f6', isDoneColumn: false },
  { name: 'Done', color: '#22c55e', isDoneColumn: true },
];

/**
 * Fire the Golden Handoff for a won deal. Kept in one place so dragging a deal into
 * Won and pressing Convert do exactly the same thing.
 */
async function runHandoff(
  deal: { id: number; businessId: number | null; title: string; company: string | null; contactEmail: string | null; value: string },
  ctx: { accountId: number; userId: number | null },
) {
  const payload: DealWonPayload = {
    dealId: deal.id, businessId: deal.businessId, title: deal.title,
    company: deal.company, contactEmail: deal.contactEmail, value: Number(deal.value),
  };
  return emit('deal.won', payload, { ...ctx, businessId: deal.businessId });
}

export async function dealRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // All deals (frontend groups by stage) + a pipeline summary. Optional ?businessId filter.
  app.get('/api/v1/deals', async (req) => {
    const { accountId } = authOf(req);
    const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    const bizFilter = q.success && q.data.businessId ? eq(deals.businessId, q.data.businessId) : undefined;
    const scope = await businessScope(req, deals.businessId);
    const rows = await db.select().from(deals)
      .where(tenantWhere(deals, accountId, bizFilter, scope))
      .orderBy(asc(deals.stage), asc(deals.position));

    const openStages = ['lead', 'contacted', 'proposal'];
    const open = rows.filter((d) => openStages.includes(d.stage));
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const wonThisMonth = rows.filter((d) => d.stage === 'won' && d.wonAt && d.wonAt >= monthStart);

    return {
      deals: rows,
      summary: {
        openCount: open.length,
        pipelineValue: Math.round(open.reduce((s, d) => s + Number(d.value), 0) * 100) / 100,
        wonThisMonth: wonThisMonth.length,
        wonValueThisMonth: Math.round(wonThisMonth.reduce((s, d) => s + Number(d.value), 0) * 100) / 100,
      },
    };
  });

  app.post('/api/v1/deals', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({
      title: z.string().trim().min(1).max(150),
      company: z.string().trim().max(150).nullable().optional(),
      contactName: z.string().trim().max(120).nullable().optional(),
      contactEmail: z.string().trim().email().max(150).nullable().optional().or(z.literal('')),
      contactPhone: z.string().trim().max(40).nullable().optional(),
      value: z.number().min(0).max(1_000_000_000).optional(),
      stage: stage.optional(),
      notes: z.string().max(5000).nullable().optional(),
      contactId: z.number().int().positive().nullable().optional(),
      source: z.string().trim().max(60).nullable().optional(),
      nextFollowUpAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      followUpNote: z.string().trim().max(200).nullable().optional(),
      businessId: z.number().int().positive().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    const st = d.stage ?? 'lead';
    const businessId = await resolveBusinessId(accountId, d.businessId);
    const position = await nextPosition(deals, sql`account_id = ${accountId} AND stage = ${st}`);
    const ins = await db.insert(deals).values(withTenant(accountId, {
      businessId, title: d.title, company: d.company ?? null, contactName: d.contactName ?? null,
      contactEmail: d.contactEmail || null, contactPhone: d.contactPhone ?? null,
      contactId: d.contactId ?? null, source: d.source ?? null,
      nextFollowUpAt: d.nextFollowUpAt ?? null, followUpNote: d.followUpNote ?? null,
      value: money(d.value ?? 0), stage: st, notes: d.notes ?? null, position, createdBy: userId,
    }));
    const [created] = await db.select().from(deals)
      .where(tenantWhere(deals, accountId, eq(deals.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ deal: created });
  });

  app.patch('/api/v1/deals/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      title: z.string().trim().min(1).max(150).optional(),
      company: z.string().trim().max(150).nullable().optional(),
      contactName: z.string().trim().max(120).nullable().optional(),
      contactEmail: z.string().trim().max(150).nullable().optional(),
      contactPhone: z.string().trim().max(40).nullable().optional(),
      value: z.number().min(0).max(1_000_000_000).optional(),
      notes: z.string().max(5000).nullable().optional(),
      contactId: z.number().int().positive().nullable().optional(),
      source: z.string().trim().max(60).nullable().optional(),
      nextFollowUpAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      followUpNote: z.string().trim().max(200).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const [own] = await db.select({ businessId: deals.businessId }).from(deals)
      .where(tenantWhere(deals, accountId, eq(deals.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Deal not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    const patch: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.value !== undefined) patch.value = money(parsed.data.value);
    const res = await db.update(deals).set(patch).where(tenantWhere(deals, accountId, eq(deals.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Deal not found.' });
    const [updated] = await db.select().from(deals).where(tenantWhere(deals, accountId, eq(deals.id, id))).limit(1);
    return { deal: updated };
  });

  // Move a deal to a stage / position (the pipeline drag).
  app.post('/api/v1/deals/:id/move', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({ stage, position: z.number().int().min(0).max(100000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [deal] = await db.select().from(deals).where(tenantWhere(deals, accountId, eq(deals.id, id))).limit(1);
    if (!deal) return reply.code(404).send({ error: 'Deal not found.' });
    if (!(await assertMaybeBusiness(req, reply, deal.businessId))) return;

    await db.transaction(async (tx) => {
      const wonPatch = parsed.data.stage === 'won' && deal.stage !== 'won' ? { wonAt: new Date() } : {};
      await tx.update(deals).set({ stage: parsed.data.stage, ...wonPatch })
        .where(tenantWhere(deals, accountId, eq(deals.id, id)));
      const siblings = await tx.select({ id: deals.id }).from(deals)
        .where(tenantWhere(deals, accountId, and(eq(deals.stage, parsed.data.stage), ne(deals.id, id))))
        .orderBy(asc(deals.position));
      const ids = siblings.map((s) => s.id);
      ids.splice(Math.min(parsed.data.position, ids.length), 0, id);
      for (let i = 0; i < ids.length; i++) {
        await tx.update(deals).set({ position: i }).where(and(eq(deals.accountId, accountId), eq(deals.id, ids[i]!)));
      }
    });
    const [moved] = await db.select().from(deals).where(tenantWhere(deals, accountId, eq(deals.id, id))).limit(1);

    if (deal.stage !== parsed.data.stage) {
      await db.insert(dealActivities).values(withTenant(accountId, {
        dealId: id, kind: 'stage' as const,
        body: `Moved from ${deal.stage} to ${parsed.data.stage}`,
        occurredAt: new Date(), createdBy: userId,
      })).catch(() => { /* history is worth having, not worth failing a drag over */ });
    }

    // Dragging a deal into Won is the moment the handoff should happen; it is the
    // way most deals actually close, not the explicit Convert button.
    let handoff: { handler: string; outcome: string; ok: boolean }[] | undefined;
    if (parsed.data.stage === 'won' && deal.stage !== 'won' && moved) {
      handoff = (await runHandoff(moved, { accountId, userId })).results;
    }
    return { deal: moved, handoff };
  });

  app.delete('/api/v1/deals/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [own] = await db.select({ businessId: deals.businessId }).from(deals)
      .where(tenantWhere(deals, accountId, eq(deals.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Deal not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    const res = await db.delete(deals).where(tenantWhere(deals, accountId, eq(deals.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Deal not found.' });
    return { ok: true };
  });

  // The point of the whole pillar: a won deal becomes a Delivery client, with a
  // starter board, so acquisition flows straight into delivery.
  app.post('/api/v1/deals/:id/convert', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [deal] = await db.select().from(deals).where(tenantWhere(deals, accountId, eq(deals.id, id))).limit(1);
    if (!deal) return reply.code(404).send({ error: 'Deal not found.' });
    if (!(await assertMaybeBusiness(req, reply, deal.businessId))) return;
    if (deal.clientFolderId) return reply.code(409).send({ error: 'This deal is already a client.' });

    await db.update(deals).set({ stage: 'won', wonAt: deal.wonAt ?? new Date() })
      .where(tenantWhere(deals, accountId, eq(deals.id, id)));
    const handoff = await runHandoff(deal, { accountId, userId });
    return reply.code(201).send({
      ok: true,
      folderId: handoff.data.folderId ?? null,
      name: deal.company || deal.title,
      handoff: handoff.results,
    });
  });
}
