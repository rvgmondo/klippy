import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { taskComments, tasks } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { notify } from '../lib/push.js';
import { appUrl } from '../lib/mailer.js';
import { users } from '../db/schema.js';
export async function commentRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.post('/api/v1/comments', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = z.object({
            taskId: z.number().int().positive(),
            comment: z.string().trim().min(1).max(10000),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [task] = await db.select({ id: tasks.id, title: tasks.title, assignedTo: tasks.assignedTo })
            .from(tasks).where(tenantWhere(tasks, accountId, eq(tasks.id, parsed.data.taskId))).limit(1);
        if (!task)
            return reply.code(400).send({ error: 'Task not found.' });
        const ins = await db.insert(taskComments).values(withTenant(accountId, {
            taskId: parsed.data.taskId, userId, comment: parsed.data.comment,
        }));
        const [created] = await db.select().from(taskComments)
            .where(tenantWhere(taskComments, accountId, eq(taskComments.id, Number(ins[0].insertId)))).limit(1);
        // Ping the card's assignee (unless they wrote the comment themselves).
        if (task.assignedTo && task.assignedTo !== userId) {
            const [author] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
            notify(task.assignedTo, {
                title: `New comment from ${author?.name ?? 'someone'}`,
                body: task.title,
                url: appUrl(),
                tag: `task-${parsed.data.taskId}`,
            });
        }
        return reply.code(201).send({ comment: created });
    });
    // Author (or admin/owner) can delete.
    app.delete('/api/v1/comments/:id', async (req, reply) => {
        const { accountId, userId, role } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [existing] = await db.select().from(taskComments)
            .where(tenantWhere(taskComments, accountId, eq(taskComments.id, id))).limit(1);
        if (!existing)
            return reply.code(404).send({ error: 'Comment not found.' });
        if (existing.userId !== userId && role === 'member') {
            return reply.code(403).send({ error: 'You can only delete your own comments.' });
        }
        await db.delete(taskComments).where(tenantWhere(taskComments, accountId, eq(taskComments.id, id)));
        return { ok: true };
    });
}
//# sourceMappingURL=comments.js.map