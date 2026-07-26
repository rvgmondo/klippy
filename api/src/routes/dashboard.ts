import type { FastifyInstance } from 'fastify';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, timeEntries, boards, folders } from '../db/schema.js';
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

    // Root pillar of any folder (a subtree inherits its top-level folder's pillar).
    const allFolders = await db.select({ id: folders.id, parentId: folders.parentId, pillar: folders.pillar })
      .from(folders).where(tenantWhere(folders, accountId));
    const fById = new Map(allFolders.map((f) => [f.id, f]));
    const rootPillar = (folderId: number): Pillar => {
      let cur = fById.get(folderId);
      for (let i = 0; i < 100 && cur?.parentId != null; i++) cur = fById.get(cur.parentId) ?? cur;
      return (cur?.pillar as Pillar) ?? 'delivery';
    };
    // board -> pillar
    const boardRows = await db.select({ id: boards.id, folderId: boards.folderId }).from(boards)
      .where(tenantWhere(boards, accountId));
    const boardPillar = new Map(boardRows.map((b) => [b.id, rootPillar(b.folderId)]));

    const buckets: Record<Pillar, Bucket> = { delivery: emptyBucket(), operations: emptyBucket() };

    // Open (not completed/archived) tasks, bucketed by pillar.
    const openTasks = await db.select({
      id: tasks.id, boardId: tasks.boardId, dueDate: tasks.dueDate, priority: tasks.priority,
    }).from(tasks).where(tenantWhere(tasks, accountId, and(eq(tasks.isArchived, false), eq(tasks.isCompleted, false))));
    for (const t of openTasks) {
      const p = boardPillar.get(t.boardId) ?? 'delivery';
      const b = buckets[p];
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
      buckets[boardPillar.get(e.boardId) ?? 'delivery'].weekSeconds += secs;
      if (e.userId === userId) weekSecondsMine += secs;
    }

    // Next 10 upcoming DELIVERY cards (the client-facing ones you invoice).
    const upcomingAll = await db.select({
      id: tasks.id, title: tasks.title, priority: tasks.priority, dueDate: tasks.dueDate, boardId: tasks.boardId,
    }).from(tasks)
      .where(tenantWhere(tasks, accountId, and(
        eq(tasks.isArchived, false), eq(tasks.isCompleted, false), isNotNull(tasks.dueDate), gte(tasks.dueDate, today))))
      .orderBy(tasks.dueDate).limit(30);
    const upcoming = upcomingAll.filter((t) => (boardPillar.get(t.boardId) ?? 'delivery') === 'delivery').slice(0, 10);

    return {
      delivery: buckets.delivery,
      operations: buckets.operations,
      weekSecondsMine,
      upcoming,
      // Backwards-compatible flat fields (Delivery view), in case anything still reads them.
      openCount: buckets.delivery.open,
      dueToday: buckets.delivery.dueToday,
      overdue: buckets.delivery.overdue,
      flagged: buckets.delivery.flagged,
      weekSecondsAll: buckets.delivery.weekSeconds + buckets.operations.weekSeconds,
    };
  });
}
