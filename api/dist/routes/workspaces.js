import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, memberships } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { getMembership, workspacesFor } from '../lib/membership.js';
import { seedNewAccount } from '../lib/seed.js';
import { COOKIE_NAME, cookieOptions, signToken, slugify } from '../lib/auth.js';
async function uniqueSlug(base) {
    const slug = slugify(base);
    for (let n = 1; n < 1000; n++) {
        const candidate = n === 1 ? slug : `${slug}-${n}`;
        const [existing] = await db.select({ id: accounts.id }).from(accounts)
            .where(eq(accounts.slug, candidate)).limit(1);
        if (!existing)
            return candidate;
    }
    return `${slug}-${Date.now()}`;
}
export async function workspaceRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // Every workspace this login can open (drives the switcher).
    app.get('/api/v1/workspaces', async (req) => {
        const { userId, accountId } = authOf(req);
        const list = await workspacesFor(userId);
        return { workspaces: list, activeAccountId: accountId };
    });
    // Switch the active workspace: re-issues the session cookie for that account.
    app.post('/api/v1/workspaces/switch', async (req, reply) => {
        const { userId } = authOf(req);
        const parsed = z.object({ accountId: z.number().int().positive() }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'accountId required.' });
        const m = await getMembership(parsed.data.accountId, userId);
        if (!m || !m.isActive)
            return reply.code(403).send({ error: 'You are not a member of that workspace.' });
        const [account] = await db.select().from(accounts).where(eq(accounts.id, parsed.data.accountId)).limit(1);
        if (!account || account.status !== 'active')
            return reply.code(403).send({ error: 'That workspace is not active.' });
        reply.setCookie(COOKIE_NAME, signToken({ uid: userId, aid: account.id, role: m.role }), cookieOptions());
        return { ok: true, accountId: account.id, role: m.role };
    });
    // Create an additional workspace; the creator becomes its owner.
    app.post('/api/v1/workspaces', async (req, reply) => {
        const { userId } = authOf(req);
        const parsed = z.object({ name: z.string().trim().min(1).max(150) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Give the workspace a name.' });
        const slug = await uniqueSlug(parsed.data.name);
        const accountId = await db.transaction(async (tx) => {
            const ins = await tx.insert(accounts).values({ name: parsed.data.name, slug });
            const newId = Number(ins[0].insertId);
            await tx.insert(memberships).values({ accountId: newId, userId, role: 'owner' });
            await seedNewAccount(tx, newId, userId, parsed.data.name);
            return newId;
        });
        // Drop straight into the new workspace.
        reply.setCookie(COOKIE_NAME, signToken({ uid: userId, aid: accountId, role: 'owner' }), cookieOptions());
        const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        return reply.code(201).send({ workspace: account });
    });
    // Leave a workspace (owners can't leave; they must hand over or delete it).
    app.post('/api/v1/workspaces/:id/leave', async (req, reply) => {
        const { userId } = authOf(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0)
            return reply.code(400).send({ error: 'Bad id.' });
        const m = await getMembership(id, userId);
        if (!m)
            return reply.code(404).send({ error: 'You are not in that workspace.' });
        if (m.role === 'owner')
            return reply.code(400).send({ error: "An owner can't leave their own workspace." });
        await db.delete(memberships).where(eq(memberships.id, m.id));
        return { ok: true };
    });
    // Delete a workspace entirely (must be owner)
    app.delete('/api/v1/workspaces/:id', async (req, reply) => {
        const { userId } = authOf(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return reply.code(400).send({ error: 'Bad id.' });
        }
        const m = await getMembership(id, userId);
        if (!m) {
            return reply.code(404).send({ error: 'You are not in that workspace.' });
        }
        if (m.role !== 'owner') {
            return reply.code(403).send({ error: 'Only the workspace owner can delete the workspace.' });
        }
        // Because your schema uses onDelete: 'cascade', deleting the account 
        // will automatically delete all memberships, businesses, folders, tasks, etc.
        await db.delete(accounts).where(eq(accounts.id, id));
        // Optional: Clear the cookie if they just deleted their active workspace
        // reply.clearCookie(COOKIE_NAME, cookieOptions());
        return { ok: true, message: 'Workspace deleted successfully.' };
    });
}
//# sourceMappingURL=workspaces.js.map