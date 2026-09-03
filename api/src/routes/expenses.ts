import type { FastifyInstance } from 'fastify';
import { money } from '../lib/money.js';
import { z } from 'zod';
import { asc, desc, eq, gte, lte, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { expenses, recurringExpenses } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness, assertBusinessAccess } from '../lib/access.js';
import { intId } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';
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
    if (d.vatAmount !== undefined) patch.vatAmount = d.vatAmount == null ? null : money(d.vatAmount);
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
      .where(tenantWhere(recurringExpenses, accountId,
        await businessScope(req, recurringExpenses.businessId)))
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
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    const businessId = await resolveBusinessId(accountId, d.businessId);
    if (!businessId) return reply.code(400).send({ error: 'No business found for this account.' });
    if (!(await assertBusinessAccess(req, reply, businessId, 'member'))) return;
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
    } as never));

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
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      description: z.string().trim().min(1).max(200).optional(),
      category: z.string().trim().max(60).nullable().optional(),
      amount: z.number().positive().max(100_000_000).optional(),
      vatAmount: z.number().min(0).max(100_000_000).nullable().optional(),
      isActive: z.boolean().optional(),
      endsOn: dateStr.nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const [own] = await db.select({ businessId: recurringExpenses.businessId }).from(recurringExpenses)
      .where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertBusinessAccess(req, reply, own.businessId, 'member'))) return;

    const d = parsed.data;
    const patch: Record<string, unknown> = { ...d };
    if (d.amount !== undefined) patch.amount = money(d.amount);
    if (d.vatAmount !== undefined) patch.vatAmount = d.vatAmount == null ? null : money(d.vatAmount);
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
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [own] = await db.select({ businessId: recurringExpenses.businessId }).from(recurringExpenses)
      .where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertBusinessAccess(req, reply, own.businessId, 'admin'))) return;
    await db.delete(recurringExpenses)
      .where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, id)));
    return { ok: true, message: 'Stopped. The costs it already recorded are kept.' };
  });
}
