import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { folders } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId, nextPosition } from '../lib/http.js';
const createSchema = z.object({
    name: z.string().trim().min(1).max(150),
    parentId: z.number().int().positive().nullable().optional(),
    color: z.string().trim().max(20).optional(),
    notes: z.string().max(5000).nullable().optional(),
});
const updateSchema = z.object({
    name: z.string().trim().min(1).max(150).optional(),
    parentId: z.number().int().positive().nullable().optional(),
    color: z.string().trim().max(20).optional(),
    notes: z.string().max(5000).nullable().optional(),
    isArchived: z.boolean().optional(),
    hourlyRate: z.number().nonnegative().max(100000).nullable().optional(),
});
/** True if `candidateParent` is `folderId` itself or a descendant of it. */
async function wouldCycle(accountId, folderId, candidateParent) {
    let cur = candidateParent;
    for (let i = 0; i < 100 && cur !== null; i++) {
        if (cur === folderId)
            return true;
        const [row] = await db.select({ parentId: folders.parentId }).from(folders)
            .where(tenantWhere(folders, accountId, eq(folders.id, cur))).limit(1);
        cur = row?.parentId ?? null;
    }
    return false;
}
export async function folderRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // Flat list of all folders for the account; the client assembles the tree.
    app.get('/api/v1/folders', async (req) => {
        const { accountId } = authOf(req);
        const rows = await db.select().from(folders)
            .where(tenantWhere(folders, accountId))
            .orderBy(asc(folders.parentId), asc(folders.position));
        return { folders: rows };
    });
    app.post('/api/v1/folders', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const { name, parentId = null, color, notes } = parsed.data;
        if (parentId) {
            const [parent] = await db.select({ id: folders.id }).from(folders)
                .where(tenantWhere(folders, accountId, eq(folders.id, parentId))).limit(1);
            if (!parent)
                return reply.code(400).send({ error: 'Parent folder not found.' });
        }
        const position = await nextPosition(folders, parentId === null
            ? sql `account_id = ${accountId} AND parent_id IS NULL`
            : sql `account_id = ${accountId} AND parent_id = ${parentId}`);
        const ins = await db.insert(folders).values(withTenant(accountId, {
            parentId, name, color: color ?? '#6366f1', notes: notes ?? null, position, createdBy: userId,
        }));
        const [created] = await db.select().from(folders)
            .where(tenantWhere(folders, accountId, eq(folders.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ folder: created });
    });
    app.patch('/api/v1/folders/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = updateSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [existing] = await db.select().from(folders)
            .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
        if (!existing)
            return reply.code(404).send({ error: 'Folder not found.' });
        // MySQL DECIMAL columns are string-typed in Drizzle.
        const patch = { ...parsed.data };
        if (parsed.data.hourlyRate !== undefined) {
            patch.hourlyRate = parsed.data.hourlyRate === null ? null : String(parsed.data.hourlyRate);
        }
        const newParent = parsed.data.parentId;
        if (newParent !== undefined && newParent !== existing.parentId) {
            if (newParent !== null) {
                const [parent] = await db.select({ id: folders.id }).from(folders)
                    .where(tenantWhere(folders, accountId, eq(folders.id, newParent))).limit(1);
                if (!parent)
                    return reply.code(400).send({ error: 'Parent folder not found.' });
                if (await wouldCycle(accountId, id, newParent)) {
                    return reply.code(400).send({ error: "Can't move a folder into itself or its own subfolder." });
                }
            }
        }
        await db.update(folders).set(patch).where(tenantWhere(folders, accountId, eq(folders.id, id)));
        const [updated] = await db.select().from(folders)
            .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
        return { folder: updated };
    });
    // Hard delete (cascades to subfolders, boards, columns, tasks via FKs).
    app.delete('/api/v1/folders/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const res = await db.delete(folders).where(tenantWhere(folders, accountId, eq(folders.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Folder not found.' });
        return { ok: true };
    });
    // Persist sibling order after drag/drop.
    app.post('/api/v1/folders/reorder', async (req, reply) => {
        const { accountId } = authOf(req);
        const body = z.object({ orderedIds: z.array(z.number().int().positive()).max(1000) }).safeParse(req.body);
        if (!body.success)
            return reply.code(400).send({ error: 'orderedIds required.' });
        await db.transaction(async (tx) => {
            for (let i = 0; i < body.data.orderedIds.length; i++) {
                await tx.update(folders).set({ position: i })
                    .where(and(eq(folders.accountId, accountId), eq(folders.id, body.data.orderedIds[i])));
            }
        });
        return { ok: true };
    });
}
//# sourceMappingURL=folders.js.map