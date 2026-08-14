import type { FastifyInstance } from 'fastify';
import { money } from '../lib/money.js';
import { z } from 'zod';
import { desc, eq, gte, lte, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { expenses } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness } from '../lib/access.js';
import { intId } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const createSchema = z.object({
  businessId: z.number().int().positive().optional(),
  folderId: z.number().int().positive().nullable().optional(),
  description: z.string().trim().min(1).max(200),
  category: z.string().trim().max(60).nullable().optional(),
  amount: z.number().min(0).max(1_000_000_000),
  incurredOn: dateStr,
});
const updateSchema = createSchema.partial();

// A simple dated cost ledger - not full accounting, just enough to answer
// "what did this business actually spend" so profit can be shown alongside revenue.
export async function expenseRoutes(app: FastifyInstance) {
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
    ].filter((f): f is NonNullable<typeof f> => !!f);
    const rows = await db.select().from(expenses)
      .where(tenantWhere(expenses, accountId, filters.length ? and(...filters) : undefined))
      .orderBy(desc(expenses.incurredOn));
    const total = Math.round(rows.reduce((s, e) => s + Number(e.amount), 0) * 100) / 100;
    return { expenses: rows, total };
  });

  app.post('/api/v1/expenses', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    const businessId = await resolveBusinessId(accountId, d.businessId);
    if (!businessId) return reply.code(400).send({ error: 'No business found for this account.' });
    const ins = await db.insert(expenses).values(withTenant(accountId, {
      businessId, folderId: d.folderId ?? null, description: d.description, category: d.category ?? null,
      amount: money(d.amount), incurredOn: d.incurredOn, createdBy: userId,
    }));
    const [created] = await db.select().from(expenses)
      .where(tenantWhere(expenses, accountId, eq(expenses.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ expense: created });
  });

  app.patch('/api/v1/expenses/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const [own] = await db.select({ businessId: expenses.businessId }).from(expenses)
      .where(tenantWhere(expenses, accountId, eq(expenses.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Expense not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    const d = parsed.data;
    const patch: Record<string, unknown> = { ...d };
    delete patch.businessId;
    if (d.amount !== undefined) patch.amount = money(d.amount);
    const res = await db.update(expenses).set(patch).where(tenantWhere(expenses, accountId, eq(expenses.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Expense not found.' });
    const [updated] = await db.select().from(expenses).where(tenantWhere(expenses, accountId, eq(expenses.id, id))).limit(1);
    return { expense: updated };
  });

  app.delete('/api/v1/expenses/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [own] = await db.select({ businessId: expenses.businessId }).from(expenses)
      .where(tenantWhere(expenses, accountId, eq(expenses.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Expense not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    const res = await db.delete(expenses).where(tenantWhere(expenses, accountId, eq(expenses.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Expense not found.' });
    return { ok: true };
  });
}
