import { z } from 'zod';
import { and, eq, or, like, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, boards, folders } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
export async function searchRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/search', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({ q: z.string().trim().min(1).max(100) }).safeParse(req.query);
        if (!q.success)
            return reply.send({ tasks: [] });
        const term = `%${q.data.q.replace(/[%_]/g, (m) => '\\' + m)}%`;
        const rows = await db.select({
            id: tasks.id, title: tasks.title, priority: tasks.priority, dueDate: tasks.dueDate,
            isCompleted: tasks.isCompleted, boardId: tasks.boardId,
            boardName: boards.name, folderName: folders.name,
        }).from(tasks)
            .leftJoin(boards, eq(boards.id, tasks.boardId))
            .leftJoin(folders, eq(folders.id, boards.folderId))
            .where(tenantWhere(tasks, accountId, and(eq(tasks.isArchived, false), or(like(tasks.title, term), like(tasks.description, term)))))
            .orderBy(desc(tasks.updatedAt))
            .limit(30);
        return { tasks: rows };
    });
}
//# sourceMappingURL=search.js.map