import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, accounts } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId, nextPosition } from '../lib/http.js';
import { seedNewBusiness } from '../lib/seed.js';

const businessType = z.enum(['services', 'products', 'code', 'content']);
const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  type: businessType.default('services'),
  color: z.string().trim().max(20).optional(),
});
const nullableStr = (max: number) => z.string().trim().max(max).nullable().optional().or(z.literal(''));
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  color: z.string().trim().max(20).optional(),
  secondaryTypes: z.array(businessType).max(4).optional(),
  notes: z.string().max(20000).nullable().optional(),
  // Brand + invoicing identity.
  brandName: nullableStr(80),
  bizAddress: nullableStr(500),
  bizTaxNumber: nullableStr(60),
  bizRegNumber: nullableStr(60),
  bankDetails: nullableStr(2000),
  invoiceFooter: nullableStr(2000),
  invoiceAccent: z.string().trim().max(20).optional(),
  defaultTaxRate: z.number().min(0).max(100).nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).optional(),
});

export async function businessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Every business in the account (the owner's companies).
  app.get('/api/v1/businesses', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select().from(businesses)
      .where(tenantWhere(businesses, accountId))
      .orderBy(asc(businesses.position));
    return { businesses: rows };
  });

  app.post('/api/v1/businesses', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const position = await nextPosition(businesses, sql`account_id = ${accountId}`);

    // A new business starts from the account's invoicing defaults (address, bank
    // details, tax rate, etc.), so it is self-contained and editable in its own
    // Business Settings rather than depending on an account-level fallback.
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);

    // Create the business on its own. `secondaryTypes` is written explicitly rather
    // than leaning on the column's DEFAULT, because a JSON default needs MySQL
    // 8.0.13+ and a strict-mode server rejects the insert outright without it.
    const ins = await db.insert(businesses).values(withTenant(accountId, {
      name: parsed.data.name, type: parsed.data.type, color: parsed.data.color ?? '#6366f1',
      secondaryTypes: [], position, createdBy: userId,
      bizAddress: acc?.bizAddress ?? null, bizTaxNumber: acc?.bizTaxNumber ?? null,
      bizRegNumber: acc?.bizRegNumber ?? null, bankDetails: acc?.bankDetails ?? null,
      invoiceFooter: acc?.invoiceFooter ?? null, invoiceAccent: acc?.invoiceAccent ?? '#6366f1',
      defaultTaxRate: acc?.defaultTaxRate ?? null, defaultDueDays: acc?.defaultDueDays ?? 14,
    }));
    const businessId = Number(ins[0].insertId);

    // Seeding example content is a convenience, not part of creating the business.
    // It touches five more tables, so if any of them trips, the business must still
    // exist rather than the whole thing rolling back into a 500.
    try {
      await db.transaction(async (tx) => {
        await seedNewBusiness(tx, accountId, userId, businessId, parsed.data.type);
      });
    } catch (err) {
      req.log.error({ err, businessId }, 'business created but seeding its example content failed');
    }

    const [row] = await db.select().from(businesses)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1);
    return reply.code(201).send({ business: row });
  });

  app.patch('/api/v1/businesses/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const patch: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.secondaryTypes) {
      const [existing] = await db.select({ type: businesses.type }).from(businesses)
        .where(tenantWhere(businesses, accountId, eq(businesses.id, id))).limit(1);
      patch.secondaryTypes = [...new Set(parsed.data.secondaryTypes)].filter((t) => t !== existing?.type);
    }
    // Empty strings from the form mean "clear it"; decimals are stored as strings.
    for (const k of ['brandName', 'bizAddress', 'bizTaxNumber', 'bizRegNumber', 'bankDetails', 'invoiceFooter'] as const) {
      if (patch[k] === '') patch[k] = null;
    }
    if (parsed.data.defaultTaxRate !== undefined) {
      patch.defaultTaxRate = parsed.data.defaultTaxRate === null ? null : String(parsed.data.defaultTaxRate);
    }
    const res = await db.update(businesses).set(patch)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Business not found.' });
    const [updated] = await db.select().from(businesses)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, id))).limit(1);
    return { business: updated };
  });

  app.delete('/api/v1/businesses/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    // Refuse to delete the last business, so an account always has at least one.
    const [countRow] = await db.select({ n: sql<number>`count(*)` }).from(businesses)
      .where(tenantWhere(businesses, accountId));
    if (Number(countRow?.n ?? 0) <= 1) return reply.code(400).send({ error: 'You need at least one business.' });
    const res = await db.delete(businesses).where(tenantWhere(businesses, accountId, eq(businesses.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Business not found.' });
    return { ok: true };
  });

  // Persist order after drag/drop.
  app.post('/api/v1/businesses/reorder', async (req, reply) => {
    const { accountId } = authOf(req);
    const body = z.object({ orderedIds: z.array(z.number().int().positive()).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'orderedIds required.' });
    await db.transaction(async (tx) => {
      for (let i = 0; i < body.data.orderedIds.length; i++) {
        await tx.update(businesses).set({ position: i })
          .where(and(eq(businesses.accountId, accountId), eq(businesses.id, body.data.orderedIds[i]!)));
      }
    });
    return { ok: true };
  });
}
