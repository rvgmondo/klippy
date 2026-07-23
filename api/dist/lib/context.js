import fp from 'fastify-plugin';
import { COOKIE_NAME, verifyToken } from './auth.js';
/**
 * Registers `app.requireAuth`, a preHandler that verifies the JWT cookie and
 * populates `req.auth`. Every tenant-scoped route MUST list it in preHandler,
 * so `req.auth.accountId` is always present for the tenant query helpers.
 */
export const authPlugin = fp(async (app) => {
    app.decorate('requireAuth', async (req, reply) => {
        const token = req.cookies?.[COOKIE_NAME];
        const payload = token ? verifyToken(token) : null;
        if (!payload) {
            await reply.code(401).send({ error: 'Not authenticated.' });
            return;
        }
        req.auth = { userId: payload.uid, accountId: payload.aid, role: payload.role };
    });
});
/** Narrowing helper: returns req.auth or throws (routes behind requireAuth). */
export function authOf(req) {
    if (!req.auth)
        throw new Error('Route used auth context without requireAuth preHandler.');
    return req.auth;
}
//# sourceMappingURL=context.js.map