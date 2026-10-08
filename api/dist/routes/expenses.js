import { money } from '../lib/money.js';
import { z } from 'zod';
import { asc, desc, eq, gte, lte, and, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { db } from '../db/client.js';
import { expenses, recurringExpenses, folders, storageNodes } from '../db/schema.js';
import { storage } from '../lib/storage.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness, assertBusinessAccess } from '../lib/access.js';
import { intId } from '../lib/http.js';
import { businessForNew } from '../lib/business.js';
import { generateFor } from '../lib/recurringExpenses.js';
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const createSchema = z.object({
    businessId: z.number().int().positive().optional(),
    folderId: z.number().int().positive().nullable().optional(),
    description: z.string().trim().min(1).max(200),
    category: z.string().trim().max(60).nullable().optional(),
    amount: z.number().min(0).max(1_000_000_000),
    // Input VAT contained in the amount, for the VAT return. Optional.
    vatAmount: z.number().min(0).max(1_000_000_000).nullable().optional(),
    incurredOn: dateStr,
});
const updateSchema = createSchema.partial();
/**
 * The client an expense is tagged to is one of THIS workspace's.
 *
 * The id was stored as sent. businessForNew only looks the folder up to pick a
 * business, and when a business was given it went on without it, so an expense
 * could point at another workspace's client and per-client profit would count it.
 */
async function folderIsMine(accountId, folderId) {
    if (folderId == null)
        return true;
    const [f] = await db.select({ id: folders.id }).from(folders)
        .where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
    return !!f;
}
/** The Receipts folder at the top of Files, made the first time it is needed. */
async function receiptsFolder(accountId, userId) {
    const [f] = await db.select({ id: storageNodes.id }).from(storageNodes)
        .where(tenantWhere(storageNodes, accountId, isNull(storageNodes.parentId), eq(storageNodes.kind, 'folder'), eq(storageNodes.name, 'Receipts'))).limit(1);
    if (f)
        return f.id;
    const ins = await db.insert(storageNodes).values(withTenant(accountId, {
        parentId: null, kind: 'folder', name: 'Receipts', uploadedBy: userId,
    }));
    return Number(ins[0].insertId);
}
const RECEIPT_BYTES = 15 * 1024 * 1024;
const RECEIPT_TYPES = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/;
// A simple dated cost ledger - not full accounting, just enough to answer
// "what did this business actually spend" so profit can be shown alongside revenue.
export async function expenseRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/expenses', async (req) => {
        const { accountId } = authOf(req);
        const q = z.object({
            businessId: z.coerce.number().int().positive().optional(),
            from: dateStr.optional(),
            to: dateStr.optional(),
        }).safeParse(req.query);
        const filters = [
            q.success && q.data.businessId ? eq(expenses.businessId, q.data.businessId) : undefined,
            q.success && q.data.from ? gte(expenses.incurredOn, q.data.from) : undefined,
            q.success && q.data.to ? lte(expenses.incurredOn, q.data.to) : undefined,
            await businessScope(req, expenses.businessId),
        ].filter((f) => !!f);
        const rows = await db.select().from(expenses)
            .where(tenantWhere(expenses, accountId, filters.length ? and(...filters) : undefined))
            .orderBy(desc(expenses.incurredOn));
        const total = Math.round(rows.reduce((s, e) => s + Number(e.amount), 0) * 100) / 100;
        return { expenses: rows, total };
    });
    app.post('/api/v1/expenses', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        if (!(await folderIsMine(accountId, d.folderId)))
            return reply.code(400).send({ error: 'That client was not found.' });
        const which = await businessForNew(accountId, d.businessId, d.folderId ?? null);
        if ('error' in which)
            return reply.code(400).send({ error: which.error });
        const businessId = which.id;
        const ins = await db.insert(expenses).values(withTenant(accountId, {
            businessId, folderId: d.folderId ?? null, description: d.description, category: d.category ?? null,
            amount: money(d.amount), vatAmount: d.vatAmount != null ? money(d.vatAmount) : null,
            incurredOn: d.incurredOn, createdBy: userId,
        }));
        const [created] = await db.select().from(expenses)
            .where(tenantWhere(expenses, accountId, eq(expenses.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ expense: created });
    });
    app.patch('/api/v1/expenses/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = updateSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [own] = await db.select({ businessId: expenses.businessId }).from(expenses)
            .where(tenantWhere(expenses, accountId, eq(expenses.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Expense not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        const d = parsed.data;
        if (!(await folderIsMine(accountId, d.folderId)))
            return reply.code(400).send({ error: 'That client was not found.' });
        const patch = { ...d };
        delete patch.businessId;
        if (d.amount !== undefined)
            patch.amount = money(d.amount);
        if (d.vatAmount !== undefined)
            patch.vatAmount = d.vatAmount == null ? null : money(d.vatAmount);
        const res = await db.update(expenses).set(patch).where(tenantWhere(expenses, accountId, eq(expenses.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Expense not found.' });
        const [updated] = await db.select().from(expenses).where(tenantWhere(expenses, accountId, eq(expenses.id, id))).limit(1);
        return { expense: updated };
    });
    app.delete('/api/v1/expenses/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [own] = await db.select({ businessId: expenses.businessId }).from(expenses)
            .where(tenantWhere(expenses, accountId, eq(expenses.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Expense not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        const res = await db.delete(expenses).where(tenantWhere(expenses, accountId, eq(expenses.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Expense not found.' });
        return { ok: true };
    });
    /**
     * Attach the receipt: a photo or PDF, filed in Files under Receipts and named
     * after the expense so it can be found there too. Replaces any earlier one.
     */
    app.post('/api/v1/expenses/:id/receipt', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [own] = await db.select().from(expenses)
            .where(tenantWhere(expenses, accountId, eq(expenses.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Expense not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        const part = await req.file({ limits: { fileSize: RECEIPT_BYTES } });
        if (!part)
            return reply.code(400).send({ error: 'No file uploaded.' });
        if (!RECEIPT_TYPES.test(part.mimetype)) {
            part.file.resume();
            return reply.code(400).send({ error: 'A receipt has to be a photo or a PDF.' });
        }
        const ext = path.extname(part.filename).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, '');
        const key = `${accountId}/${Date.now()}_${randomBytes(8).toString('hex')}${ext}`;
        const size = await storage().save(key, part.file);
        if (part.file.truncated) {
            await storage().delete(key);
            return reply.code(400).send({ error: 'That file is larger than 15MB. A photo of the slip is plenty.' });
        }
        const parentId = await receiptsFolder(accountId, userId);
        const name = `${own.incurredOn} ${own.description}`.replace(/[\\/:*?"<>|]/g, '-').slice(0, 200) + ext;
        const ins = await db.insert(storageNodes).values(withTenant(accountId, {
            parentId, kind: 'file', name, storageKey: key, size, mimeType: part.mimetype, uploadedBy: userId,
        }));
        const nodeId = Number(ins[0].insertId);
        await db.update(expenses).set({ receiptNodeId: nodeId })
            .where(tenantWhere(expenses, accountId, eq(expenses.id, id)));
        // The one it replaces goes, file and all, or Receipts fills with orphans.
        if (own.receiptNodeId)
            await removeNode(accountId, own.receiptNodeId);
        return reply.code(201).send({ receiptNodeId: nodeId });
    });
    app.delete('/api/v1/expenses/:id/receipt', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [own] = await db.select().from(expenses)
            .where(tenantWhere(expenses, accountId, eq(expenses.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Expense not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        await db.update(expenses).set({ receiptNodeId: null })
            .where(tenantWhere(expenses, accountId, eq(expenses.id, id)));
        if (own.receiptNodeId)
            await removeNode(accountId, own.receiptNodeId);
        return { ok: true };
    });
    async function removeNode(accountId, nodeId) {
        const [n] = await db.select().from(storageNodes)
            .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, nodeId), eq(storageNodes.kind, 'file'))).limit(1);
        if (!n)
            return;
        if (n.storageKey)
            await storage().delete(n.storageKey).catch(() => { });
        await db.delete(storageNodes).where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, nodeId)));
    }
    /**
     * The costs that repeat.
     *
     * Kept beside expenses rather than in a file of their own because they are the same
     * subject: one is a cost that happened, the other is a cost that keeps happening.
     * Everything the reports read is still the ordinary expenses table.
     */
    app.get('/api/v1/recurring-expenses', async (req) => {
        const { accountId } = authOf(req);
        const rows = await db.select().from(recurringExpenses)
            .where(tenantWhere(recurringExpenses, accountId, await businessScope(req, recurringExpenses.businessId)))
            .orderBy(desc(recurringExpenses.isActive), asc(recurringExpenses.nextDueOn));
        return { recurring: rows };
    });
    app.post('/api/v1/recurring-expenses', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = z.object({
            businessId: z.number().int().positive().optional(),
            description: z.string().trim().min(1).max(200),
            category: z.string().trim().max(60).nullable().optional(),
            amount: z.number().positive().max(100_000_000),
            vatAmount: z.number().min(0).max(100_000_000).nullable().optional(),
            intervalMonths: z.number().int().min(1).max(12).default(1),
            startedOn: dateStr,
            endsOn: dateStr.nullable().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        const which = await businessForNew(accountId, d.businessId, null);
        if ('error' in which)
            return reply.code(400).send({ error: which.error });
        const businessId = which.id;
        if (!(await assertBusinessAccess(req, reply, businessId, 'member')))
            return;
        if (d.endsOn && d.endsOn < d.startedOn) {
            return reply.code(400).send({ error: 'The end date cannot be before it starts.' });
        }
        const ins = await db.insert(recurringExpenses).values(withTenant(accountId, {
            businessId, description: d.description, category: d.category ?? null,
            amount: money(d.amount), vatAmount: d.vatAmount != null ? money(d.vatAmount) : null,
            intervalMonths: d.intervalMonths,
            // Due from the day it started, so a cost entered late still records the months
            // it has already been running rather than pretending it began today.
            startedOn: d.startedOn, nextDueOn: d.startedOn, endsOn: d.endsOn ?? null,
            createdBy: userId,
        }));
        // Catch up immediately. Waiting for tonight would mean adding a cost and seeing
        // no change, which reads as the button not having worked.
        const [row] = await db.select().from(recurringExpenses)
            .where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, Number(ins[0].insertId)))).limit(1);
        const gen = row ? await generateFor(accountId, row) : { written: 0, skipped: 0 };
        return reply.code(201).send({ id: Number(ins[0].insertId), recorded: gen.written });
    });
    app.patch('/api/v1/recurring-expenses/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({
            description: z.string().trim().min(1).max(200).optional(),
            category: z.string().trim().max(60).nullable().optional(),
            amount: z.number().positive().max(100_000_000).optional(),
            vatAmount: z.number().min(0).max(100_000_000).nullable().optional(),
            isActive: z.boolean().optional(),
            endsOn: dateStr.nullable().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [own] = await db.select({ businessId: recurringExpenses.businessId }).from(recurringExpenses)
            .where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Not found.' });
        if (!(await assertBusinessAccess(req, reply, own.businessId, 'member')))
            return;
        const d = parsed.data;
        const patch = { ...d };
        if (d.amount !== undefined)
            patch.amount = money(d.amount);
        if (d.vatAmount !== undefined)
            patch.vatAmount = d.vatAmount == null ? null : money(d.vatAmount);
        await db.update(recurringExpenses).set(patch)
            .where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, id)));
        return { ok: true };
    });
    /**
     * Stop a standing cost.
     *
     * The expenses it already wrote are KEPT. They are real money that really left the
     * business, and deleting them would rewrite history and change a VAT return that may
     * already have been filed. Ending it stops the future, not the past.
     */
    app.delete('/api/v1/recurring-expenses/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [own] = await db.select({ businessId: recurringExpenses.businessId }).from(recurringExpenses)
            .where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Not found.' });
        if (!(await assertBusinessAccess(req, reply, own.businessId, 'admin')))
            return;
        await db.delete(recurringExpenses)
            .where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, id)));
        return { ok: true, message: 'Stopped. The costs it already recorded are kept.' };
    });
}
//# sourceMappingURL=expenses.js.map