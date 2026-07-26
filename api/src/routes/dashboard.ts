import type { FastifyInstance } from 'fastify';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { tasks, timeEntries, boards, folders, businesses } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

type Pillar = 'delivery' | 'operations';
interface Bucket { open: number; dueToday: number; overdue: number; flagged: number; weekSeconds: number }
const emptyBucket = (): Bucket => ({ open: 0, dueToday: 0, overdue: 0, flagged: 0, weekSeconds: 0 });

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/v1/dashboard', async (req) => {
    const { accountId, userId } = authOf(req);
    const today = todayStr();
    // Optional filter: one business, or (omitted) the whole account combined.
    const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    const onlyBusiness = q.success ? q.data.businessId : undefined;

    const bizRows = await db.select({ id: businesses.id, name: businesses.name }).from(businesses)
      .where(tenantWhere(businesses, accountId));

    // Root pillar of any folder (a subtree inherits its top-level folder's pillar).
    const allFolders = await db.select({
      id: folders.id, parentId: folders.parentId, pillar: folders.pillar, businessId: folders.businessId,
    }).from(folders).where(tenantWhere(folders, accountId));
    const fById = new Map(allFolders.map((f) => [f.id, f]));
    const rootPillar = (folderId: number): Pillar => {
      let cur = fById.get(folderId);
      for (let i = 0; i < 100 && cur?.parentId != null; i++) cur = fById.get(cur.parentId) ?? cur;
      return (cur?.pillar as Pillar) ?? 'delivery';
    };
    // board -> { pillar, businessId }
    const boardRows = await db.select({ id: boards.id, folderId: boards.folderId }).from(boards)
      .where(tenantWhere(boards, accountId));
    const boardMeta = new Map(boardRows.map((b) => [b.id, {
      pillar: rootPillar(b.folderId),
      businessId: fById.get(b.folderId)?.businessId ?? null,
    }]));

    const inScope = (businessId: number | null) => onlyBusiness === undefined || businessId === onlyBusiness;

    const buckets: Record<Pillar, Bucket> = { delivery: emptyBucket(), operations: emptyBucket() };
    // Per-business roll-up for the combined Home view (always full account).
    const perBusiness = new Map<number, { open: number; weekSeconds: number }>();
    const bump = (bid: number | null, openInc: number, secInc: number) => {
      if (bid == null) return;
      const cur = perBusiness.get(bid) ?? { open: 0, weekSeconds: 0 };
      cur.open += openInc; cur.weekSeconds += secInc;
      perBusiness.set(bid, cur);
    };

    // Open (not completed/archived) tasks, bucketed by pillar (and business).
    const openTasks = await db.select({
      id: tasks.id, boardId: tasks.boardId, dueDate: tasks.dueDate, priority: tasks.priority,
    }).from(tasks).where(tenantWhere(tasks, accountId, and(eq(tasks.isArchived, false), eq(tasks.isCompleted, false))));
    for (const t of openTasks) {
      const meta = boardMeta.get(t.boardId);
      bump(meta?.businessId ?? null, 1, 0);
      if (!inScope(meta?.businessId ?? null)) continue;
      const b = buckets[meta?.pillar ?? 'delivery'];
      b.open++;
      if (t.dueDate) {
        if (t.dueDate === today) b.dueToday++;
        else if (t.dueDate < today) b.overdue++;
      }
      if (t.priority === 'high' || t.priority === 'urgent') b.flagged++;
    }

    // Time this week (Mon 00:00 UTC), bucketed by pillar; plus "mine" total.
    const now = new Date();
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    monday.setUTCHours(0, 0, 0, 0);
    const entries = await db.select({
      seconds: timeEntries.durationSeconds, userId: timeEntries.userId, boardId: tasks.boardId,
    }).from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(tenantWhere(timeEntries, accountId, and(isNotNull(timeEntries.durationSeconds), gte(timeEntries.startTime, monday))));
    let weekSecondsMine = 0;
    for (const e of entries) {
      const secs = Number(e.seconds ?? 0);
      const meta = boardMeta.get(e.boardId);
      bump(meta?.businessId ?? null, 0, secs);
      if (!inScope(meta?.businessId ?? null)) continue;
      buckets[meta?.pillar ?? 'delivery'].weekSeconds += secs;
      if (e.userId === userId) weekSecondsMine += secs;
    }

    // Next 10 upcoming DELIVERY cards (the client-facing ones you invoice), in scope.
    const upcomingAll = await db.select({
      id: tasks.id, title: tasks.title, priority: tasks.priority, dueDate: tasks.dueDate, boardId: tasks.boardId,
    }).from(tasks)
      .where(tenantWhere(tasks, accountId, and(
        eq(tasks.isArchived, false), eq(tasks.isCompleted, false), isNotNull(tasks.dueDate), gte(tasks.dueDate, today))))
      .orderBy(tasks.dueDate).limit(50);
    const upcoming = upcomingAll.filter((t) => {
      const meta = boardMeta.get(t.boardId);
      return (meta?.pillar ?? 'delivery') === 'delivery' && inScope(meta?.businessId ?? null);
    }).slice(0, 10);

    return {
      delivery: buckets.delivery,
      operations: buckets.operations,
      weekSecondsMine,
      upcoming,
      businesses: bizRows.map((b) => ({
        id: b.id, name: b.name,
        open: perBusiness.get(b.id)?.open ?? 0,
        weekSeconds: perBusiness.get(b.id)?.weekSeconds ?? 0,
      })),
      // Backwards-compatible flat fields (Delivery view).
      openCount: buckets.delivery.open,
      dueToday: buckets.delivery.dueToday,
      overdue: buckets.delivery.overdue,
      flagged: buckets.delivery.flagged,
      weekSecondsAll: buckets.delivery.weekSeconds + buckets.operations.weekSeconds,
    };
  });
}
