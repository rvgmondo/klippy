import { z } from 'zod';
import { and, desc, eq, gte, lte, isNotNull, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, folders, boards, tasks, timeEntries } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
const lineSchema = z.object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().nonnegative().max(1_000_000),
    unitPrice: z.number().max(100_000_000).min(-100_000_000),
});
const docType = z.enum(['quote', 'invoice']);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const bodySchema = z.object({
    type: docType,
    folderId: z.number().int().positive().nullable().optional(),
    clientName: z.string().trim().min(1).max(150),
    clientEmail: z.string().trim().email().max(150).nullable().optional().or(z.literal('')),
    clientAddress: z.string().max(2000).nullable().optional(),
    issueDate: dateStr,
    dueDate: dateStr.nullable().optional(),
    taxRate: z.number().min(0).max(100).optional(),
    notes: z.string().max(5000).nullable().optional(),
    lines: z.array(lineSchema).max(200),
});
const PREFIX = { quote: 'QUO-', invoice: 'INV-' };
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
function computeTotals(lines, taxRate) {
    const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const taxAmount = subtotal * (taxRate / 100);
    return { subtotal, taxAmount, total: subtotal + taxAmount };
}
export async function documentRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // List (summary), optionally filtered by type.
    app.get('/api/v1/documents', async (req) => {
        const { accountId } = authOf(req);
        const q = z.object({ type: docType.optional() }).safeParse(req.query);
        const extra = q.success && q.data.type ? eq(documents.type, q.data.type) : undefined;
        const rows = await db.select({
            id: documents.id, type: documents.type, number: documents.number,
            clientName: documents.clientName, issueDate: documents.issueDate, dueDate: documents.dueDate,
            status: documents.status, currency: documents.currency, total: documents.total,
        }).from(documents)
            .where(tenantWhere(documents, accountId, extra))
            .orderBy(desc(documents.createdAt));
        return { documents: rows };
    });
    // One document with its line items.
    app.get('/api/v1/documents/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [doc] = await db.select().from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
        if (!doc)
            return reply.code(404).send({ error: 'Not found.' });
        const lines = await db.select().from(documentLines)
            .where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, id)))
            .orderBy(documentLines.position);
        const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        return { document: doc, lines, brand: { name: account?.brandName ?? 'Klippy', hasLogo: !!account?.logoPath } };
    });
    app.post('/api/v1/documents', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        const currency = account?.currency ?? 'ZAR';
        const taxRate = d.taxRate ?? 0;
        const totals = computeTotals(d.lines, taxRate);
        // Next number for this account + type.
        const [row] = await db.select({ m: sql `COALESCE(MAX(seq),0)` }).from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.type, d.type)));
        const seq = Number(row?.m ?? 0) + 1;
        const number = `${PREFIX[d.type]}${String(seq).padStart(4, '0')}`;
        const docId = await db.transaction(async (tx) => {
            const ins = await tx.insert(documents).values(withTenant(accountId, {
                type: d.type, seq, number, folderId: d.folderId ?? null,
                clientName: d.clientName, clientEmail: d.clientEmail || null, clientAddress: d.clientAddress ?? null,
                issueDate: d.issueDate, dueDate: d.dueDate ?? null, currency,
                taxRate: money(taxRate), subtotal: money(totals.subtotal),
                taxAmount: money(totals.taxAmount), total: money(totals.total),
                notes: d.notes ?? null, createdBy: userId,
            }));
            const newId = Number(ins[0].insertId);
            if (d.lines.length) {
                await tx.insert(documentLines).values(d.lines.map((l, i) => withTenant(accountId, {
                    documentId: newId, description: l.description, quantity: money(l.quantity),
                    unitPrice: money(l.unitPrice), amount: money(l.quantity * l.unitPrice), position: i,
                })));
            }
            return newId;
        });
        const [created] = await db.select().from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.id, docId))).limit(1);
        return reply.code(201).send({ document: created });
    });
    // Replace the whole document (fields + lines).
    app.put('/api/v1/documents/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        const [existing] = await db.select().from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
        if (!existing)
            return reply.code(404).send({ error: 'Not found.' });
        const taxRate = d.taxRate ?? 0;
        const totals = computeTotals(d.lines, taxRate);
        await db.transaction(async (tx) => {
            await tx.update(documents).set({
                folderId: d.folderId ?? null, clientName: d.clientName, clientEmail: d.clientEmail || null,
                clientAddress: d.clientAddress ?? null, issueDate: d.issueDate, dueDate: d.dueDate ?? null,
                taxRate: money(taxRate), subtotal: money(totals.subtotal),
                taxAmount: money(totals.taxAmount), total: money(totals.total), notes: d.notes ?? null,
            }).where(tenantWhere(documents, accountId, eq(documents.id, id)));
            await tx.delete(documentLines).where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, id)));
            if (d.lines.length) {
                await tx.insert(documentLines).values(d.lines.map((l, i) => withTenant(accountId, {
                    documentId: id, description: l.description, quantity: money(l.quantity),
                    unitPrice: money(l.unitPrice), amount: money(l.quantity * l.unitPrice), position: i,
                })));
            }
        });
        const [updated] = await db.select().from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
        return { document: updated };
    });
    // Change just the status (draft -> sent -> paid, etc).
    app.patch('/api/v1/documents/:id/status', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({ status: z.enum(['draft', 'sent', 'accepted', 'paid', 'void']) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Bad status.' });
        const res = await db.update(documents).set({ status: parsed.data.status })
            .where(tenantWhere(documents, accountId, eq(documents.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Not found.' });
        return { ok: true };
    });
    app.delete('/api/v1/documents/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const res = await db.delete(documents).where(tenantWhere(documents, accountId, eq(documents.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Not found.' });
        return { ok: true };
    });
    // Turn an accepted quote into a fresh invoice (copies client + lines).
    app.post('/api/v1/documents/:id/convert', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [quote] = await db.select().from(documents)
            .where(tenantWhere(documents, accountId, and(eq(documents.id, id), eq(documents.type, 'quote')))).limit(1);
        if (!quote)
            return reply.code(404).send({ error: 'Quote not found.' });
        const lines = await db.select().from(documentLines)
            .where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, id))).orderBy(documentLines.position);
        const [row] = await db.select({ m: sql `COALESCE(MAX(seq),0)` }).from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.type, 'invoice')));
        const seq = Number(row?.m ?? 0) + 1;
        const number = `${PREFIX.invoice}${String(seq).padStart(4, '0')}`;
        const today = new Date().toISOString().slice(0, 10);
        const newId = await db.transaction(async (tx) => {
            const ins = await tx.insert(documents).values(withTenant(accountId, {
                type: 'invoice', seq, number, folderId: quote.folderId,
                clientName: quote.clientName, clientEmail: quote.clientEmail, clientAddress: quote.clientAddress,
                issueDate: today, dueDate: null, currency: quote.currency, taxRate: quote.taxRate,
                subtotal: quote.subtotal, taxAmount: quote.taxAmount, total: quote.total,
                notes: quote.notes, createdBy: userId,
            }));
            const iid = Number(ins[0].insertId);
            if (lines.length) {
                await tx.insert(documentLines).values(lines.map((l, i) => withTenant(accountId, {
                    documentId: iid, description: l.description, quantity: l.quantity,
                    unitPrice: l.unitPrice, amount: l.amount, position: i,
                })));
            }
            return iid;
        });
        await db.update(documents).set({ status: 'accepted' })
            .where(tenantWhere(documents, accountId, eq(documents.id, id)));
        const [created] = await db.select().from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.id, newId))).limit(1);
        return reply.code(201).send({ document: created });
    });
    // Suggest invoice lines from tracked time for a client folder in a date range.
    // One line per board that had time logged, quantity = hours, unit = the
    // client's inherited hourly rate. Ready to drop straight into a new invoice.
    app.get('/api/v1/documents/from-time', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({
            folderId: z.coerce.number().int().positive(),
            from: dateStr, to: dateStr,
        }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'folderId, from, to required.' });
        const allFolders = await db.select({
            id: folders.id, parentId: folders.parentId, name: folders.name, hourlyRate: folders.hourlyRate,
        }).from(folders).where(tenantWhere(folders, accountId));
        const byId = new Map(allFolders.map((f) => [f.id, f]));
        const client = byId.get(q.data.folderId);
        if (!client)
            return reply.code(404).send({ error: 'Client not found.' });
        // Rate inherited from the nearest ancestor that sets one.
        let rate = 0;
        for (let cur = client, i = 0; cur && i < 100; i++) {
            if (cur.hourlyRate != null) {
                rate = Number(cur.hourlyRate);
                break;
            }
            if (cur.parentId == null)
                break;
            cur = byId.get(cur.parentId);
        }
        // All folders in this client's subtree (itself + descendants).
        const subtree = new Set([client.id]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const f of allFolders) {
                if (f.parentId != null && subtree.has(f.parentId) && !subtree.has(f.id)) {
                    subtree.add(f.id);
                    grew = true;
                }
            }
        }
        const boardRows = await db.select({ id: boards.id, name: boards.name }).from(boards)
            .where(tenantWhere(boards, accountId, inArray(boards.folderId, [...subtree])));
        if (boardRows.length === 0)
            return { clientName: client.name, rate, lines: [], totalHours: 0 };
        const boardName = new Map(boardRows.map((b) => [b.id, b.name]));
        const start = new Date(`${q.data.from}T00:00:00.000Z`);
        const end = new Date(`${q.data.to}T23:59:59.999Z`);
        const rows = await db.select({
            boardId: tasks.boardId,
            seconds: sql `COALESCE(SUM(${timeEntries.durationSeconds}),0)`,
        }).from(timeEntries)
            .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
            .where(tenantWhere(timeEntries, accountId, and(isNotNull(timeEntries.durationSeconds), inArray(tasks.boardId, boardRows.map((b) => b.id)), gte(timeEntries.startTime, start), lte(timeEntries.startTime, end))))
            .groupBy(tasks.boardId);
        let totalHours = 0;
        const lines = rows
            .map((r) => {
            const hours = Math.round((Number(r.seconds) / 3600) * 100) / 100;
            totalHours += hours;
            return {
                description: `${boardName.get(r.boardId) ?? 'Work'} (${q.data.from} to ${q.data.to})`,
                quantity: hours,
                unitPrice: rate,
            };
        })
            .filter((l) => l.quantity > 0)
            .sort((a, b) => b.quantity - a.quantity);
        return { clientName: client.name, rate, totalHours: Math.round(totalHours * 100) / 100, lines };
    });
}
//# sourceMappingURL=documents.js.map