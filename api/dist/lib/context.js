import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiTokens, users, memberships } from '../db/schema.js';
import { COOKIE_NAME, verifyToken } from './auth.js';
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** Resolve an `Authorization: Bearer <token>` API token to an auth context. */
async function authFromBearer(header) {
    if (!header?.startsWith('Bearer '))
        return null;
    const raw = header.slice(7).trim();
    if (!raw)
        return null;
    const [row] = await db.select({
        id: apiTokens.id, accountId: apiTokens.accountId, userId: apiTokens.userId,
        role: memberships.role, memberActive: memberships.isActive, userActive: users.isActive,
    }).from(apiTokens)
        .innerJoin(users, eq(users.id, apiTokens.userId))
        // The token only works while its owner is still an active member of that workspace.
        .innerJoin(memberships, and(eq(memberships.userId, apiTokens.userId), eq(memberships.accountId, apiTokens.accountId)))
        .where(eq(apiTokens.tokenHash, sha256(raw)))
        .limit(1);
    if (!row || !row.role || !row.memberActive || !row.userActive)
        return null;
    // Best-effort last-used stamp; never block the request on it.
    void db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).catch(() => { });
    return { userId: row.userId, accountId: row.accountId, role: row.role };
}
/**
 * The current, live membership for a cookie session: role read fresh from the DB,
 * and null the instant the user or their membership is deactivated. One indexed
 * lookup per request, the same cost the Bearer path already pays.
 */
async function liveMembership(userId, accountId, tokenEpoch) {
    const [row] = await db.select({
        role: memberships.role, memberActive: memberships.isActive, userActive: users.isActive,
        sessionEpoch: users.sessionEpoch,
    }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.userId, userId), eq(memberships.accountId, accountId)))
        .limit(1);
    if (!row || !row.role || !row.memberActive || !row.userActive)
        return null;
    // A token from before the last password change / "sign out everywhere" is dead,
    // however long its JWT expiry has left.
    if ((row.sessionEpoch ?? 0) !== tokenEpoch)
        return null;
    return { userId, accountId, role: row.role };
}
/** The user's current session epoch, for signing a fresh token. */
export async function sessionEpochOf(userId) {
    const [u] = await db.select({ se: users.sessionEpoch }).from(users).where(eq(users.id, userId)).limit(1);
    return u?.se ?? 0;
}
/**
 * Registers `app.requireAuth`, a preHandler that authenticates via the JWT
 * cookie (web app) or an API token (browser extension / integrations) and
 * populates `req.auth`. Every tenant-scoped route MUST list it in preHandler,
 * so `req.auth.accountId` is always present for the tenant query helpers.
 */
export const authPlugin = fp(async (app) => {
    app.decorate('requireAuth', async (req, reply) => {
        const token = req.cookies?.[COOKIE_NAME];
        const payload = token ? verifyToken(token) : null;
        if (payload) {
            // Re-read the membership live, exactly as the Bearer path does. The JWT is
            // valid for 7 days; without this check, deactivating, demoting, or
            // password-resetting a member does nothing until it expires, so a fired or
            // compromised employee keeps full access for up to a week. The current role
            // is taken from the DB, not the token, so a demotion also takes effect at once.
            const live = await liveMembership(payload.uid, payload.aid, payload.se ?? 0);
            if (live) {
                req.auth = live;
                return;
            }
            // The token verifies but the membership is gone or suspended: treat as logged
            // out and clear the cookie so the app stops presenting it.
            void reply.clearCookie(COOKIE_NAME, { path: '/' });
            await reply.code(401).send({ error: 'Your access to this workspace has changed. Please sign in again.' });
            return;
        }
        const viaToken = await authFromBearer(req.headers.authorization);
        if (viaToken) {
            req.auth = viaToken;
            return;
        }
        await reply.code(401).send({ error: 'Not authenticated.' });
    });
});
/** Narrowing helper: returns req.auth or throws (routes behind requireAuth). */
export function authOf(req) {
    if (!req.auth)
        throw new Error('Route used auth context without requireAuth preHandler.');
    return req.auth;
}
//# sourceMappingURL=context.js.map