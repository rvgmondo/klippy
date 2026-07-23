import type { FastifyInstance } from 'fastify';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, timeEntries } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/v1/dashboard', async (req) => {
    const { accountId, userId } = authOf(req);
    const today = todayStr();

    const activeTasks = tenantWhere(tasks, accountId, and(eq(tasks.isArchived, false), eq(tasks.isCompleted, false)));

    const [openCount] = await db.select({ c: sql<number>`COUNT(*)` }).from(tasks).where(activeTasks);
    const [dueToday] = await db.select({ c: sql<number>`COUNT(*)` }).from(tasks)
      .where(tenantWhere(tasks, accountId, and(
        eq(tasks.isArchived, false), eq(tasks.isCompleted, false), eq(tasks.dueDate, today))));
    const [overdue] = await db.select({ c: sql<number>`COUNT(*)` }).from(tasks)
      .where(tenantWhere(tasks, accountId, and(
        eq(tasks.isArchived, false), eq(tasks.isCompleted, false),
        isNotNull(tasks.dueDate), lt(tasks.dueDate, today))));
    const [flagged] = await db.select({ c: sql<number>`COUNT(*)` }).from(tasks)
      .where(tenantWhere(tasks, accountId, and(
        eq(tasks.isArchived, false), eq(tasks.isCompleted, false),
        sql`priority IN ('high','urgent')`)));

    // Time tracked this week (Mon 00:00 UTC), account-wide and mine.
    const now = new Date();
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    monday.setUTCHours(0, 0, 0, 0);

    const [weekAll] = await db.select({ s: sql<number>`COALESCE(SUM(duration_seconds),0)` }).from(timeEntries)
      .where(tenantWhere(timeEntries, accountId, gte(timeEntries.startTime, monday)));
    const [weekMine] = await db.select({ s: sql<number>`COALESCE(SUM(duration_seconds),0)` }).from(timeEntries)
      .where(tenantWhere(timeEntries, accountId, and(gte(timeEntries.startTime, monday), eq(timeEntries.userId, userId))));

    // Next 14 days of due cards, soonest first.
    const upcoming = await db.select({
      id: tasks.id, title: tasks.title, priority: tasks.priority,
      dueDate: tasks.dueDate, boardId: tasks.boardId,
    }).from(tasks)
      .where(tenantWhere(tasks, accountId, and(
        eq(tasks.isArchived, false), eq(tasks.isCompleted, false),
        isNotNull(tasks.dueDate), gte(tasks.dueDate, today))))
      .orderBy(tasks.dueDate)
      .limit(10);

    return {
      openCount: Number(openCount?.c ?? 0),
      dueToday: Number(dueToday?.c ?? 0),
      overdue: Number(overdue?.c ?? 0),
      flagged: Number(flagged?.c ?? 0),
      weekSecondsAll: Number(weekAll?.s ?? 0),
      weekSecondsMine: Number(weekMine?.s ?? 0),
      upcoming,
    };
  });
}
