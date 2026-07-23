import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
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

/**
 * Registers `app.requireAuth`, a preHandler that verifies the JWT cookie and
 * populates `req.auth`. Every tenant-scoped route MUST list it in preHandler,
 * so `req.auth.accountId` is always present for the tenant query helpers.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorate(
    'requireAuth',
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = req.cookies?.[COOKIE_NAME];
      const payload = token ? verifyToken(token) : null;
      if (!payload) {
        await reply.code(401).send({ error: 'Not authenticated.' });
        return;
      }
      req.auth = { userId: payload.uid, accountId: payload.aid, role: payload.role };
    },
  );
});

/** Narrowing helper: returns req.auth or throws (routes behind requireAuth). */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new Error('Route used auth context without requireAuth preHandler.');
  return req.auth;
}
