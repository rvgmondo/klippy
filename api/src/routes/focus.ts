import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, isNotNull, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { focusItems, tasks, boards, folders, businesses, documents, deals } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant, isDuplicateKey } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { accessibleBusinessIds, assertMaybeBusiness, assertTaskAccess } from '../lib/access.js';
import { formatMoney } from '../lib/currency.js';
import { balancesFor } from '../lib/balances.js';

/**
 * Home as an Eisenhower matrix, across every business at once.
 *
 * The point of the paper version is that everything competing for one person's
 * attention sits on one page, so the comparison is forced. The point of doing it here
 * instead is that half of it fills itself in: Klippy already knows what is urgent,
 * because it holds every due date, every overdue invoice, every quote about to lapse
 * and every follow-up that was promised. So the machine does urgency, and the founder
 * only makes the judgement a machine cannot make, which is what actually matters.
 *
 * Three rules, and they are the difference between a useful page and another
 * dashboard nobody opens:
 *
 *  1. IT MUST STAY ONE PAGE. Every source is capped. A matrix that lists everything
 *     is a backlog with extra steps, and the whole value is that it forces a choice.
 *  2. NOTHING IS COPIED. An auto item reads its title, date and amount from the live
 *     record every time. Only the judgement is stored, so this page cannot drift into
 *     showing an invoice that was paid last week.
 *  3. THE TOP RIGHT IS THE PRODUCT. Important and not urgent is the work that builds
 *     the business, and it is the quadrant that starves, because nothing in it has a
 *     deadline shouting. It is the one quadrant fed by hand, and the emptier it is the
 *     louder this page should say so.
 */

const OPEN_DEAL_STAGES = ['lead', 'contacted', 'proposal'] as const;
/** How near a quote's expiry has to be before it starts competing for attention. */
const QUOTE_EXPIRY_WINDOW_DAYS = 7;
/** Per source, so no single source can flood the page. */
const PER_SOURCE_CAP = 10;

type Kind = 'manual' | 'task' | 'invoice' | 'quote' | 'deal';

interface Item {
  key: string;
  kind: Kind;
  refId: number | null;
  title: string;
  detail: string | null;
  businessId: number | null;
  urgent: boolean;
  important: boolean;
  due: string | null;
  /** How overdue, in days. Negative means it has not arrived yet. */
  overdueBy: number | null;
  view: string;
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000);
const addDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00.000Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export async function focusRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/v1/focus', async (req) => {
    const { accountId } = authOf(req);
    const today = todayStr();
    const allowed = await accessibleBusinessIds(req);
    const canSee = (bid: number | null) => allowed === null || bid == null || allowed.has(bid);

    const bizRows = await db.select({ id: businesses.id, name: businesses.name, color: businesses.color })
      .from(businesses).where(tenantWhere(businesses, accountId)).orderBy(asc(businesses.position));

    // Stored judgements, keyed the same way the items are, so a demotion survives.
    const stored = await db.select().from(focusItems)
      .where(tenantWhere(focusItems, accountId, isNull(focusItems.doneAt)));
    const judged = new Map(stored.filter((r) => r.kind !== 'manual' && r.refId != null)
      .map((r) => [r.kind + ':' + r.refId, r.important]));

    const items: Item[] = [];
    const push = (i: Item) => { if (canSee(i.businessId)) items.push(i); };
    // Auto items start important and are demoted by hand. That is why a workspace
    // with nothing configured still shows a matrix worth looking at.
    const importance = (kind: Kind, refId: number) => judged.get(kind + ':' + refId) ?? true;

    // ---- Cards due or overdue ------------------------------------------------
    const cardRows = await db.select({
      id: tasks.id, title: tasks.title, dueDate: tasks.dueDate,
      businessId: folders.businessId, folderName: folders.name,
    }).from(tasks)
      .innerJoin(boards, eq(boards.id, tasks.boardId))
      .leftJoin(folders, eq(folders.id, boards.folderId))
      .where(tenantWhere(tasks, accountId, and(
        eq(tasks.isCompleted, false), eq(tasks.isArchived, false),
        isNull(boards.deletedAt), isNull(folders.deletedAt),
        isNotNull(tasks.dueDate), lte(tasks.dueDate, today),
      )))
      .orderBy(asc(tasks.dueDate))
      .limit(PER_SOURCE_CAP);
    for (const t of cardRows) {
      push({
        key: 'task:' + t.id, kind: 'task', refId: t.id, title: t.title,
        detail: t.folderName, businessId: t.businessId ?? null,
        urgent: true, important: importance('task', t.id),
        due: t.dueDate, overdueBy: t.dueDate ? -daysBetween(t.dueDate, today) : null,
        view: 'today',
      });
    }

    // ---- Invoices past due ---------------------------------------------------
    const overdueRows = await db.select({
      id: documents.id, number: documents.number, clientName: documents.clientName,
      dueDate: documents.dueDate, total: documents.total, currency: documents.currency,
      businessId: documents.businessId,
    }).from(documents)
      .where(tenantWhere(documents, accountId, and(
        eq(documents.type, 'invoice'), eq(documents.status, 'sent'),
        isNotNull(documents.dueDate), lte(documents.dueDate, today),
      )))
      .orderBy(asc(documents.dueDate))
      .limit(PER_SOURCE_CAP);
    /**
     * What is still OWED, not the face value.
     *
     * status='sent' does not mean "nothing has been paid": settleIfCovered only flips
     * an invoice to 'paid' once the balance reaches zero, so a part-paid invoice, or
     * one carrying a credit note, sits here at 'sent' with its full total. Printing
     * that total on the page the founder makes decisions from meant chasing a client
     * for money they had already sent. Same helper the collections list and the
     * reminder job use, batched into two queries whatever the row count.
     */
    const owedBy = await balancesFor(accountId, overdueRows);
    for (const d of overdueRows) {
      const owed = owedBy.get(d.id)?.outstanding ?? Number(d.total);
      // Covered but not yet flipped: it is not owed, so it is not urgent.
      if (owed <= 0.001) continue;
      const by = d.dueDate ? -daysBetween(d.dueDate, today) : 0;
      push({
        key: 'invoice:' + d.id, kind: 'invoice', refId: d.id,
        title: d.clientName + ' owes ' + formatMoney(owed, d.currency),
        detail: by > 0 ? d.number + ', ' + by + ' days overdue' : d.number + ', due today',
        businessId: d.businessId, urgent: true, important: importance('invoice', d.id),
        due: d.dueDate, overdueBy: by, view: 'collections',
      });
    }

    // ---- Quotes about to lapse ----------------------------------------------
    const quoteRows = await db.select({
      id: documents.id, number: documents.number, clientName: documents.clientName,
      dueDate: documents.dueDate, total: documents.total, currency: documents.currency,
      businessId: documents.businessId,
    }).from(documents)
      .where(tenantWhere(documents, accountId, and(
        eq(documents.type, 'quote'), eq(documents.status, 'sent'),
        isNull(documents.decision),
        isNotNull(documents.dueDate),
        lte(documents.dueDate, addDays(today, QUOTE_EXPIRY_WINDOW_DAYS)),
      )))
      .orderBy(asc(documents.dueDate))
      .limit(PER_SOURCE_CAP);
    for (const q of quoteRows) {
      const left = q.dueDate ? daysBetween(q.dueDate, today) : 0;
      push({
        key: 'quote:' + q.id, kind: 'quote', refId: q.id,
        title: 'Quote for ' + q.clientName + ' (' + formatMoney(q.total, q.currency) + ')',
        detail: left < 0 ? q.number + ' has expired'
          : left === 0 ? q.number + ' expires today'
            : q.number + ' expires in ' + left + ' days',
        businessId: q.businessId, urgent: true, important: importance('quote', q.id),
        due: q.dueDate, overdueBy: -left, view: 'billing',
      });
    }

    // ---- Follow-ups promised and reached -------------------------------------
    const dealRows = await db.select({
      id: deals.id, title: deals.title, company: deals.company,
      nextFollowUpAt: deals.nextFollowUpAt, followUpNote: deals.followUpNote,
      businessId: deals.businessId,
    }).from(deals)
      .where(tenantWhere(deals, accountId, and(
        inArray(deals.stage, [...OPEN_DEAL_STAGES]),
        isNotNull(deals.nextFollowUpAt), lte(deals.nextFollowUpAt, today),
      )))
      .orderBy(asc(deals.nextFollowUpAt))
      .limit(PER_SOURCE_CAP);
    for (const d of dealRows) {
      push({
        key: 'deal:' + d.id, kind: 'deal', refId: d.id,
        title: 'Follow up: ' + (d.company || d.title),
        detail: d.followUpNote, businessId: d.businessId,
        urgent: true, important: importance('deal', d.id),
        due: d.nextFollowUpAt,
        overdueBy: d.nextFollowUpAt ? -daysBetween(d.nextFollowUpAt, today) : null,
        view: 'pipeline',
      });
    }

    // ---- What he put there himself -------------------------------------------
    for (const m of stored) {
      if (m.kind !== 'manual') continue;
      push({
        key: 'manual:' + m.id, kind: 'manual', refId: m.id, title: m.title ?? '',
        detail: null, businessId: m.businessId,
        // A manual item is urgent only once its own date arrives. Most never get one,
        // which is the point: they belong on the calm side of the cross.
        urgent: !!m.dueDate && m.dueDate <= today,
        important: m.important, due: m.dueDate,
        overdueBy: m.dueDate ? -daysBetween(m.dueDate, today) : null,
        view: 'home',
      });
    }

    const quadrantOf = (i: Item) =>
      i.urgent ? (i.important ? 'now' : 'quick') : (i.important ? 'real' : 'later');
    const quadrants: Record<string, Item[]> = { now: [], real: [], quick: [], later: [] };
    for (const i of items) quadrants[quadrantOf(i)]!.push(i);
    // Most overdue first where the deadline is the point.
    quadrants.now!.sort((a, b) => (b.overdueBy ?? 0) - (a.overdueBy ?? 0));
    quadrants.quick!.sort((a, b) => (b.overdueBy ?? 0) - (a.overdueBy ?? 0));

    return {
      today,
      businesses: bizRows.filter((b) => canSee(b.id)),
      quadrants,
      counts: {
        now: quadrants.now!.length, real: quadrants.real!.length,
        quick: quadrants.quick!.length, later: quadrants.later!.length,
      },
    };
  });

  /** Add something by hand. Mostly the top right: the work with no deadline. */
  app.post('/api/v1/focus', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({
      title: z.string().trim().min(1).max(200),
      businessId: z.number().int().positive().nullable().optional(),
      important: z.boolean().optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    // assertMaybeBusiness rather than a bare accessible-ids check: the latter waves
    // owners and admins straight through, so a business id belonging to ANOTHER
    // account would have been stored unverified.
    if (!(await assertMaybeBusiness(req, reply, d.businessId ?? null, 'viewer'))) return;
    const ins = await db.insert(focusItems).values(withTenant(accountId, {
      kind: 'manual' as const, title: d.title, businessId: d.businessId ?? null,
      important: d.important ?? true, dueDate: d.dueDate ?? null, createdBy: userId,
    }));
    return reply.code(201).send({ id: Number(ins[0].insertId) });
  });

  /**
   * Move something across the importance axis.
   *
   * For an auto item this writes the only thing the matrix ever stores about it. It
   * is an upsert on (account, kind, refId), so clicking twice leaves one opinion
   * behind rather than two.
   */
  app.patch('/api/v1/focus/judge', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({
      kind: z.enum(['task', 'invoice', 'quote', 'deal']),
      refId: z.number().int().positive(),
      important: z.boolean(),
      businessId: z.number().int().positive().nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const { kind, refId, important } = parsed.data;

    /**
     * Prove the thing being judged is one this person can actually see.
     *
     * The judgement is stored per account and read by everyone in it, so without this
     * a member scoped to one business could reach an id belonging to another and move
     * that invoice out of the owner's Do-today quadrant. Ids are sequential, so
     * guessing one takes no knowledge of the other business at all. The business is
     * taken from the resolved row rather than from the request body for the same
     * reason: the body is the caller's claim, not a fact.
     */
    let businessId: number | null = null;
    if (kind === 'task') {
      if (!(await assertTaskAccess(req, reply, refId, 'viewer'))) return;
      const [row] = await db.select({ businessId: folders.businessId }).from(tasks)
        .innerJoin(boards, eq(boards.id, tasks.boardId))
        .leftJoin(folders, eq(folders.id, boards.folderId))
        .where(tenantWhere(tasks, accountId, eq(tasks.id, refId))).limit(1);
      businessId = row?.businessId ?? null;
    } else {
      const table = kind === 'deal' ? deals : documents;
      const [row] = await db.select({ businessId: table.businessId }).from(table)
        .where(tenantWhere(table, accountId, eq(table.id, refId))).limit(1);
      if (!row) return reply.code(404).send({ error: 'That is no longer there.' });
      businessId = row.businessId;
      if (!(await assertMaybeBusiness(req, reply, businessId, 'viewer'))) return;
    }

    const [existing] = await db.select({ id: focusItems.id }).from(focusItems)
      .where(tenantWhere(focusItems, accountId, eq(focusItems.kind, kind), eq(focusItems.refId, refId)))
      .limit(1);
    if (existing) {
      await db.update(focusItems).set({ important, doneAt: null })
        .where(tenantWhere(focusItems, accountId, eq(focusItems.id, existing.id)));
      return { ok: true, id: existing.id };
    }
    try {
      const ins = await db.insert(focusItems).values(withTenant(accountId, {
        kind, refId, important, businessId, createdBy: userId,
      }));
      return { ok: true, id: Number(ins[0].insertId) };
    } catch (err) {
      // Two clicks landing together: the unique index means the other one won, and
      // its answer is the same as ours would have been.
      if (isDuplicateKey(err)) return { ok: true };
      throw err;
    }
  });

  app.patch('/api/v1/focus/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      title: z.string().trim().min(1).max(200).optional(),
      important: z.boolean().optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const patch: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.important !== undefined) patch.important = parsed.data.important;
    if (parsed.data.dueDate !== undefined) patch.dueDate = parsed.data.dueDate;
    if (!Object.keys(patch).length) return reply.code(400).send({ error: 'Nothing to change.' });
    const res = await db.update(focusItems).set(patch)
      .where(tenantWhere(focusItems, accountId, eq(focusItems.id, id), eq(focusItems.kind, 'manual')));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
    return { ok: true };
  });

  /** Tick off a manual item. An auto item leaves on its own when the real thing is done. */
  app.post('/api/v1/focus/:id/done', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const res = await db.update(focusItems).set({ doneAt: new Date() })
      .where(tenantWhere(focusItems, accountId, eq(focusItems.id, id), eq(focusItems.kind, 'manual')));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
    return { ok: true };
  });

  app.delete('/api/v1/focus/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const res = await db.delete(focusItems)
      .where(tenantWhere(focusItems, accountId, eq(focusItems.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
    return { ok: true };
  });
}
