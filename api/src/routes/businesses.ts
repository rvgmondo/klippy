import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId, nextPosition } from '../lib/http.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  color: z.string().trim().max(20).optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  color: z.string().trim().max(20).optional(),
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
    const ins = await db.insert(businesses).values(withTenant(accountId, {
      name: parsed.data.name, color: parsed.data.color ?? '#6366f1', position, createdBy: userId,
    }));
    const [created] = await db.select().from(businesses)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ business: created });
  });

  app.patch('/api/v1/businesses/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const res = await db.update(businesses).set(parsed.data)
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
