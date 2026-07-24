import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiTokens, users } from '../db/schema.js';
import { COOKIE_NAME, verifyToken, type TokenPayload } from './auth.js';

// The authenticated context attached to every request that passes `requireAuth`.
export interface AuthContext {
  userId: number;
  accountId: number;
  role: TokenPayload['role'];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Resolve an `Authorization: Bearer <token>` API token to an auth context. */
async function authFromBearer(header: string | undefined): Promise<AuthContext | null> {
  if (!header?.startsWith('Bearer ')) return null;
  const raw = header.slice(7).trim();
  if (!raw) return null;
  const [row] = await db.select({
    id: apiTokens.id, accountId: apiTokens.accountId, userId: apiTokens.userId,
    role: users.role, isActive: users.isActive,
  }).from(apiTokens)
    .leftJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, sha256(raw)))
    .limit(1);
  if (!row || !row.role || !row.isActive) return null;
  // Best-effort last-used stamp; never block the request on it.
  void db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).catch(() => {});
  return { userId: row.userId, accountId: row.accountId, role: row.role };
}

/**
 * Registers `app.requireAuth`, a preHandler that authenticates via the JWT
 * cookie (web app) or an API token (browser extension / integrations) and
 * populates `req.auth`. Every tenant-scoped route MUST list it in preHandler,
 * so `req.auth.accountId` is always present for the tenant query helpers.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorate(
    'requireAuth',
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = req.cookies?.[COOKIE_NAME];
      const payload = token ? verifyToken(token) : null;
      if (payload) {
        req.auth = { userId: payload.uid, accountId: payload.aid, role: payload.role };
        return;
      }
      const viaToken = await authFromBearer(req.headers.authorization);
      if (viaToken) {
        req.auth = viaToken;
        return;
      }
      await reply.code(401).send({ error: 'Not authenticated.' });
    },
  );
});

/** Narrowing helper: returns req.auth or throws (routes behind requireAuth). */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new Error('Route used auth context without requireAuth preHandler.');
  return req.auth;
}
