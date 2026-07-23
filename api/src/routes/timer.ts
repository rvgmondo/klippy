import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { timeEntries, tasks } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';

async function taskInAccount(accountId: number, taskId: number): Promise<boolean> {
  const [t] = await db.select({ id: tasks.id }).from(tasks)
    .where(tenantWhere(tasks, accountId, eq(tasks.id, taskId))).limit(1);
  return !!t;
}

/** Stop the user's currently-running entry (if any); returns the closed row id. */
async function stopRunning(accountId: number, userId: number): Promise<number | null> {
  const [open] = await db.select().from(timeEntries)
    .where(tenantWhere(timeEntries, accountId, and(eq(timeEntries.userId, userId), isNull(timeEntries.endTime))))
    .limit(1);
  if (!open) return null;
  const end = new Date();
  const duration = Math.max(0, Math.floor((end.getTime() - open.startTime.getTime()) / 1000));
  await db.update(timeEntries).set({ endTime: end, durationSeconds: duration })
    .where(tenantWhere(timeEntries, accountId, eq(timeEntries.id, open.id)));
  return open.id;
}

export async function timerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // The caller's currently-running timer, if any (with task title).
  app.get('/api/v1/timer/current', async (req) => {
    const { accountId, userId } = authOf(req);
    const [open] = await db.select({
      id: timeEntries.id, taskId: timeEntries.taskId, startTime: timeEntries.startTime,
      taskTitle: tasks.title,
    }).from(timeEntries)
      .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(tenantWhere(timeEntries, accountId, and(eq(timeEntries.userId, userId), isNull(timeEntries.endTime))))
      .limit(1);
    return { current: open ?? null };
  });

  // Start a timer on a task. Auto-stops any running one (v1 behaviour).
  app.post('/api/v1/timer/start', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({ taskId: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'taskId required.' });
    if (!(await taskInAccount(accountId, parsed.data.taskId))) return reply.code(400).send({ error: 'Task not found.' });

    await stopRunning(accountId, userId);
    const ins = await db.insert(timeEntries).values(withTenant(accountId, {
      taskId: parsed.data.taskId, userId, startTime: new Date(), isManual: false,
    }));
    const [created] = await db.select().from(timeEntries)
      .where(tenantWhere(timeEntries, accountId, eq(timeEntries.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ entry: created });
  });

  app.post('/api/v1/timer/stop', async (req) => {
    const { accountId, userId } = authOf(req);
    const stoppedId = await stopRunning(accountId, userId);
    return { ok: true, stoppedId };
  });

  // Manual entry: minutes spent on a task, logged now.
  app.post('/api/v1/timer/manual', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({
      taskId: z.number().int().positive(),
      minutes: z.number().int().min(1).max(24 * 60),
      note: z.string().trim().max(255).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    if (!(await taskInAccount(accountId, parsed.data.taskId))) return reply.code(400).send({ error: 'Task not found.' });
    const end = new Date();
    const start = new Date(end.getTime() - parsed.data.minutes * 60000);
    const ins = await db.insert(timeEntries).values(withTenant(accountId, {
      taskId: parsed.data.taskId, userId, startTime: start, endTime: end,
      durationSeconds: parsed.data.minutes * 60, note: parsed.data.note ?? null, isManual: true,
    }));
    const [created] = await db.select().from(timeEntries)
      .where(tenantWhere(timeEntries, accountId, eq(timeEntries.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ entry: created });
  });

  // Entries for one task (for the card detail time log).
  app.get('/api/v1/tasks/:id/time', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const entries = await db.select().from(timeEntries)
      .where(tenantWhere(timeEntries, accountId, eq(timeEntries.taskId, id)))
      .orderBy(desc(timeEntries.startTime));
    const [total] = await db.select({ s: sql<number>`COALESCE(SUM(duration_seconds),0)` }).from(timeEntries)
      .where(tenantWhere(timeEntries, accountId, eq(timeEntries.taskId, id)));
    return { entries, totalSeconds: Number(total?.s ?? 0) };
  });

  app.delete('/api/v1/time-entries/:id', async (req, reply) => {
    const { accountId, userId, role } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [existing] = await db.select().from(timeEntries)
      .where(tenantWhere(timeEntries, accountId, eq(timeEntries.id, id))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'Entry not found.' });
    if (existing.userId !== userId && role === 'member') {
      return reply.code(403).send({ error: 'You can only delete your own time entries.' });
    }
    await db.delete(timeEntries).where(tenantWhere(timeEntries, accountId, eq(timeEntries.id, id)));
    return { ok: true };
  });
}
