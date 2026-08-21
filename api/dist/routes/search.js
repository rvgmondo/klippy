import { z } from 'zod';
import { and, eq, or, like, desc, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, boards, folders, deals, contacts, documents, offerings } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { businessScope } from '../lib/access.js';
/**
 * Universal search: one query over everything the workspace remembers.
 *
 * This used to search kanban cards and nothing else, which silently broke the
 * cross-module promise the whole product is built on: the data was one store, but
 * the search box only knew about one table. A client, an invoice number, a deal, a
 * contact and an offering are all findable now, grouped and typed so the caller
 * can route each result to its own screen.
 *
 * Every branch carries the same tenant guard and the caller's business scope, so
 * search can never show a member something their access would not.
 */
export async function searchRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/search', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({ q: z.string().trim().min(1).max(100) }).safeParse(req.query);
        if (!q.success)
            return reply.send({ tasks: [], clients: [], deals: [], contacts: [], documents: [], offerings: [] });
        const term = `%${q.data.q.replace(/[%_]/g, (m) => '\\' + m)}%`;
        const taskRows = await db.select({
            id: tasks.id, title: tasks.title, priority: tasks.priority, dueDate: tasks.dueDate,
            isCompleted: tasks.isCompleted, boardId: tasks.boardId,
            boardName: boards.name, folderName: folders.name,
        }).from(tasks)
            .leftJoin(boards, eq(boards.id, tasks.boardId))
            .leftJoin(folders, eq(folders.id, boards.folderId))
            .where(tenantWhere(tasks, accountId, and(eq(tasks.isArchived, false), isNull(boards.deletedAt), isNull(folders.deletedAt), or(like(tasks.title, term), like(tasks.description, term)))))
            .orderBy(desc(tasks.updatedAt))
            .limit(12);
        // Clients: top-level folders. Their first board rides along so a hit can land
        // straight on the client's work rather than on a blank Boards screen.
        const clientRows = await db.select({
            id: folders.id, name: folders.name, businessId: folders.businessId, pillar: folders.pillar,
        }).from(folders)
            .where(tenantWhere(folders, accountId, isNull(folders.parentId), isNull(folders.deletedAt), like(folders.name, term), await businessScope(req, folders.businessId)))
            .limit(8);
        const clientIds = clientRows.map((c) => c.id);
        const clientBoards = clientIds.length
            ? await db.select({ id: boards.id, folderId: boards.folderId }).from(boards)
                .where(tenantWhere(boards, accountId, inArray(boards.folderId, clientIds), isNull(boards.deletedAt)))
            : [];
        const firstBoard = new Map();
        for (const b of clientBoards)
            if (b.folderId != null && !firstBoard.has(b.folderId))
                firstBoard.set(b.folderId, b.id);
        const dealRows = await db.select({
            id: deals.id, title: deals.title, company: deals.company, stage: deals.stage, value: deals.value,
        }).from(deals)
            .where(tenantWhere(deals, accountId, or(like(deals.title, term), like(deals.company, term), like(deals.contactName, term)), await businessScope(req, deals.businessId)))
            .orderBy(desc(deals.updatedAt))
            .limit(8);
        const contactRows = await db.select({
            id: contacts.id, name: contacts.name, company: contacts.company, email: contacts.email,
        }).from(contacts)
            .where(tenantWhere(contacts, accountId, or(like(contacts.name, term), like(contacts.company, term), like(contacts.email, term)), await businessScope(req, contacts.businessId)))
            .limit(8);
        const docRows = await db.select({
            id: documents.id, number: documents.number, type: documents.type,
            clientName: documents.clientName, status: documents.status,
            total: documents.total, currency: documents.currency,
        }).from(documents)
            .where(tenantWhere(documents, accountId, or(like(documents.number, term), like(documents.clientName, term)), await businessScope(req, documents.businessId)))
            .orderBy(desc(documents.createdAt))
            .limit(8);
        const offeringRows = await db.select({
            id: offerings.id, name: offerings.name, price: offerings.price, recurring: offerings.recurring,
        }).from(offerings)
            .where(tenantWhere(offerings, accountId, like(offerings.name, term), await businessScope(req, offerings.businessId)))
            .limit(8);
        return {
            tasks: taskRows,
            clients: clientRows.map((c) => ({ ...c, boardId: firstBoard.get(c.id) ?? null })),
            deals: dealRows,
            contacts: contactRows,
            documents: docRows,
            offerings: offeringRows,
        };
    });
}
//# sourceMappingURL=search.js.map