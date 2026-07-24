import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiTokens } from '../db/schema.js';
import { authOf, sha256 } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';

export async function tokenRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Your own tokens (never returns the secret; it is shown once at creation).
  app.get('/api/v1/tokens', async (req) => {
    const { accountId, userId } = authOf(req);
    const rows = await db.select({
      id: apiTokens.id, name: apiTokens.name,
      lastUsedAt: apiTokens.lastUsedAt, createdAt: apiTokens.createdAt,
    }).from(apiTokens)
      .where(tenantWhere(apiTokens, accountId, eq(apiTokens.userId, userId)))
      .orderBy(desc(apiTokens.createdAt));
    return { tokens: rows };
  });

  app.post('/api/v1/tokens', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Give the token a name.' });

    // 32 random bytes, shown to the user exactly once.
    const secret = `klp_${randomBytes(32).toString('hex')}`;
    const ins = await db.insert(apiTokens).values(withTenant(accountId, {
      userId, name: parsed.data.name, tokenHash: sha256(secret),
    }));
    const [created] = await db.select({
      id: apiTokens.id, name: apiTokens.name, createdAt: apiTokens.createdAt,
    }).from(apiTokens)
      .where(tenantWhere(apiTokens, accountId, eq(apiTokens.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ token: created, secret });
  });

  app.delete('/api/v1/tokens/:id', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const res = await db.delete(apiTokens)
      .where(tenantWhere(apiTokens, accountId, and(eq(apiTokens.id, id), eq(apiTokens.userId, userId))));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Token not found.' });
    return { ok: true };
  });
}
