import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { boards, boardColumns, tasks, folders, taskLabels, labels } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId, nextPosition } from '../lib/http.js';
const createSchema = z.object({
    folderId: z.number().int().positive(),
    name: z.string().trim().min(1).max(150),
    description: z.string().trim().max(255).nullable().optional(),
});
const updateSchema = z.object({
    name: z.string().trim().min(1).max(150).optional(),
    description: z.string().trim().max(255).nullable().optional(),
    folderId: z.number().int().positive().optional(),
    isArchived: z.boolean().optional(),
});
const DEFAULT_COLUMNS = [
    { name: 'To do', color: '#94a3b8', isDoneColumn: false },
    { name: 'Doing', color: '#3b82f6', isDoneColumn: false },
    { name: 'Done', color: '#22c55e', isDoneColumn: true },
];
export async function boardRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // Boards in a folder.
    app.get('/api/v1/boards', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({ folderId: z.coerce.number().int().positive() }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'folderId required.' });
        const rows = await db.select().from(boards)
            .where(tenantWhere(boards, accountId, and(eq(boards.folderId, q.data.folderId), eq(boards.isArchived, false))))
            .orderBy(asc(boards.position));
        return { boards: rows };
    });
    // Full board: columns (ordered) + non-archived tasks. The main kanban read.
    app.get('/api/v1/boards/:id/full', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [board] = await db.select().from(boards)
            .where(tenantWhere(boards, accountId, eq(boards.id, id))).limit(1);
        if (!board)
            return reply.code(404).send({ error: 'Board not found.' });
        const columns = await db.select().from(boardColumns)
            .where(tenantWhere(boardColumns, accountId, eq(boardColumns.boardId, id)))
            .orderBy(asc(boardColumns.position));
        const cards = await db.select().from(tasks)
            .where(tenantWhere(tasks, accountId, and(eq(tasks.boardId, id), eq(tasks.isArchived, false))))
            .orderBy(asc(tasks.position));
        // Label chips for every card on this board (frontend groups by taskId).
        const cardLabels = await db.select({
            taskId: taskLabels.taskId, id: labels.id, name: labels.name, color: labels.color,
        }).from(taskLabels)
            .innerJoin(labels, eq(labels.id, taskLabels.labelId))
            .innerJoin(tasks, eq(tasks.id, taskLabels.taskId))
            .where(tenantWhere(taskLabels, accountId, eq(tasks.boardId, id)));
        return { board, columns, tasks: cards, cardLabels };
    });
    app.post('/api/v1/boards', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const { folderId, name, description } = parsed.data;
        const [folder] = await db.select({ id: folders.id }).from(folders)
            .where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
        if (!folder)
            return reply.code(400).send({ error: 'Folder not found.' });
        const position = await nextPosition(boards, sql `account_id = ${accountId} AND folder_id = ${folderId}`);
        const boardId = await db.transaction(async (tx) => {
            const ins = await tx.insert(boards).values(withTenant(accountId, {
                folderId, name, description: description ?? null, position, createdBy: userId,
            }));
            const newId = Number(ins[0].insertId);
            await tx.insert(boardColumns).values(DEFAULT_COLUMNS.map((c, i) => withTenant(accountId, { boardId: newId, name: c.name, color: c.color, isDoneColumn: c.isDoneColumn, position: i })));
            return newId;
        });
        const [created] = await db.select().from(boards)
            .where(tenantWhere(boards, accountId, eq(boards.id, boardId))).limit(1);
        return reply.code(201).send({ board: created });
    });
    app.patch('/api/v1/boards/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = updateSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        if (parsed.data.folderId) {
            const [folder] = await db.select({ id: folders.id }).from(folders)
                .where(tenantWhere(folders, accountId, eq(folders.id, parsed.data.folderId))).limit(1);
            if (!folder)
                return reply.code(400).send({ error: 'Folder not found.' });
        }
        const res = await db.update(boards).set(parsed.data)
            .where(tenantWhere(boards, accountId, eq(boards.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Board not found.' });
        const [updated] = await db.select().from(boards)
            .where(tenantWhere(boards, accountId, eq(boards.id, id))).limit(1);
        return { board: updated };
    });
    app.delete('/api/v1/boards/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const res = await db.delete(boards).where(tenantWhere(boards, accountId, eq(boards.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Board not found.' });
        return { ok: true };
    });
}
//# sourceMappingURL=boards.js.map