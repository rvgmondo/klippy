import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { labels, taskLabels, tasks } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';

async function taskInAccount(accountId: number, taskId: number): Promise<boolean> {
  const [t] = await db.select({ id: tasks.id }).from(tasks)
    .where(tenantWhere(tasks, accountId, eq(tasks.id, taskId))).limit(1);
  return !!t;
}
async function labelInAccount(accountId: number, labelId: number): Promise<boolean> {
  const [l] = await db.select({ id: labels.id }).from(labels)
    .where(tenantWhere(labels, accountId, eq(labels.id, labelId))).limit(1);
  return !!l;
}

export async function labelRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/v1/labels', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select().from(labels).where(tenantWhere(labels, accountId)).orderBy(labels.name);
    return { labels: rows };
  });

  app.post('/api/v1/labels', async (req, reply) => {
    const { accountId } = authOf(req);
    const parsed = z.object({
      name: z.string().trim().min(1).max(50),
      color: z.string().trim().max(20).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const ins = await db.insert(labels).values(withTenant(accountId, { name: parsed.data.name, color: parsed.data.color ?? '#6366f1' }));
    const [created] = await db.select().from(labels).where(tenantWhere(labels, accountId, eq(labels.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ label: created });
  });

  app.patch('/api/v1/labels/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({ name: z.string().trim().min(1).max(50).optional(), color: z.string().trim().max(20).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const res = await db.update(labels).set(parsed.data).where(tenantWhere(labels, accountId, eq(labels.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Label not found.' });
    const [updated] = await db.select().from(labels).where(tenantWhere(labels, accountId, eq(labels.id, id))).limit(1);
    return { label: updated };
  });

  app.delete('/api/v1/labels/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const res = await db.delete(labels).where(tenantWhere(labels, accountId, eq(labels.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Label not found.' });
    return { ok: true };
  });

  // Attach a label to a task.
  app.post('/api/v1/tasks/:id/labels', async (req, reply) => {
    const { accountId } = authOf(req);
    const taskId = intId(req);
    if (!taskId) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({ labelId: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'labelId required.' });
    if (!(await taskInAccount(accountId, taskId)) || !(await labelInAccount(accountId, parsed.data.labelId))) {
      return reply.code(400).send({ error: 'Task or label not found.' });
    }
    const [exists] = await db.select({ id: taskLabels.id }).from(taskLabels)
      .where(tenantWhere(taskLabels, accountId, and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, parsed.data.labelId)))).limit(1);
    if (!exists) {
      await db.insert(taskLabels).values(withTenant(accountId, { taskId, labelId: parsed.data.labelId }));
    }
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/v1/tasks/:id/labels/:labelId', async (req, reply) => {
    const { accountId } = authOf(req);
    const taskId = intId(req);
    const labelId = intId(req, 'labelId');
    if (!taskId || !labelId) return reply.code(400).send({ error: 'Bad id.' });
    await db.delete(taskLabels)
      .where(tenantWhere(taskLabels, accountId, and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, labelId))));
    return { ok: true };
  });
}
