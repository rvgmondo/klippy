import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { taskSubtasks, tasks } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { assertTaskAccess, assertSubtaskAccess } from '../lib/access.js';
import { intId, nextPosition } from '../lib/http.js';
async function taskInAccount(accountId, taskId) {
    const [t] = await db.select({ id: tasks.id }).from(tasks)
        .where(tenantWhere(tasks, accountId, eq(tasks.id, taskId))).limit(1);
    return !!t;
}
export async function subtaskRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.post('/api/v1/subtasks', async (req, reply) => {
        const { accountId } = authOf(req);
        const parsed = z.object({
            taskId: z.number().int().positive(),
            title: z.string().trim().min(1).max(200),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        if (!(await taskInAccount(accountId, parsed.data.taskId)))
            return reply.code(400).send({ error: 'Task not found.' });
        if (!(await assertTaskAccess(req, reply, parsed.data.taskId, 'member')))
            return;
        const position = await nextPosition(taskSubtasks, sql `account_id = ${accountId} AND task_id = ${parsed.data.taskId}`);
        const ins = await db.insert(taskSubtasks).values(withTenant(accountId, {
            taskId: parsed.data.taskId, title: parsed.data.title, position,
        }));
        const [created] = await db.select().from(taskSubtasks)
            .where(tenantWhere(taskSubtasks, accountId, eq(taskSubtasks.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ subtask: created });
    });
    app.patch('/api/v1/subtasks/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertSubtaskAccess(req, reply, id, 'member')))
            return;
        const parsed = z.object({
            title: z.string().trim().min(1).max(200).optional(),
            isCompleted: z.boolean().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const res = await db.update(taskSubtasks).set(parsed.data)
            .where(tenantWhere(taskSubtasks, accountId, eq(taskSubtasks.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Subtask not found.' });
        const [updated] = await db.select().from(taskSubtasks)
            .where(tenantWhere(taskSubtasks, accountId, eq(taskSubtasks.id, id))).limit(1);
        return { subtask: updated };
    });
    app.delete('/api/v1/subtasks/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertSubtaskAccess(req, reply, id, 'member')))
            return;
        const res = await db.delete(taskSubtasks).where(tenantWhere(taskSubtasks, accountId, eq(taskSubtasks.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Subtask not found.' });
        return { ok: true };
    });
}
//# sourceMappingURL=subtasks.js.map