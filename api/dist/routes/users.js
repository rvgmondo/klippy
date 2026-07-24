import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { intId } from '../lib/http.js';
function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive, lastLogin: u.lastLogin };
}
async function activeAdminCount(accountId, excludeUserId) {
    const [row] = await db.select({ c: sql `COUNT(*)` }).from(users)
        .where(tenantWhere(users, accountId, and(eq(users.isActive, true), sql `role IN ('owner','admin')`, excludeUserId ? ne(users.id, excludeUserId) : undefined)));
    return Number(row?.c ?? 0);
}
export async function userRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // List workspace members (any member may read, for the assignee picker).
    app.get('/api/v1/users', async (req) => {
        const { accountId } = authOf(req);
        const rows = await db.select().from(users)
            .where(tenantWhere(users, accountId)).orderBy(users.name);
        return { users: rows.map(publicUser) };
    });
    // Update your OWN profile: display name and/or password. Any member can do this.
    // Changing a password requires the current one.
    app.patch('/api/v1/profile', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = z.object({
            name: z.string().trim().min(1).max(100).optional(),
            currentPassword: z.string().min(1).max(200).optional(),
            newPassword: z.string().min(8, 'New password must be at least 8 characters').max(200).optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [me] = await db.select().from(users)
            .where(tenantWhere(users, accountId, eq(users.id, userId))).limit(1);
        if (!me)
            return reply.code(404).send({ error: 'Account not found.' });
        const patch = {};
        if (parsed.data.name !== undefined)
            patch.name = parsed.data.name;
        if (parsed.data.newPassword) {
            if (!parsed.data.currentPassword) {
                return reply.code(400).send({ error: 'Enter your current password to change it.' });
            }
            const ok = await verifyPassword(parsed.data.currentPassword, me.passwordHash);
            if (!ok)
                return reply.code(403).send({ error: 'Your current password is not correct.' });
            patch.passwordHash = await hashPassword(parsed.data.newPassword);
        }
        if (Object.keys(patch).length === 0)
            return reply.code(400).send({ error: 'Nothing to update.' });
        await db.update(users).set(patch).where(tenantWhere(users, accountId, eq(users.id, userId)));
        const [updated] = await db.select().from(users)
            .where(tenantWhere(users, accountId, eq(users.id, userId))).limit(1);
        return { user: updated ? publicUser(updated) : null };
    });
    // Create a member (admin/owner only). No email yet, so admin sets a password.
    app.post('/api/v1/users', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can add people.' });
        const parsed = z.object({
            name: z.string().trim().min(1).max(100),
            email: z.string().trim().toLowerCase().email().max(150),
            password: z.string().min(8).max(200),
            role: z.enum(['admin', 'member']).default('member'),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, parsed.data.email)).limit(1);
        if (dupe)
            return reply.code(409).send({ error: 'That email is already in use.' });
        const passwordHash = await hashPassword(parsed.data.password);
        const ins = await db.insert(users).values({
            accountId, name: parsed.data.name, email: parsed.data.email, passwordHash, role: parsed.data.role,
        });
        const [created] = await db.select().from(users)
            .where(tenantWhere(users, accountId, eq(users.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ user: created ? publicUser(created) : null });
    });
    // Update a member: role, active state, name, or reset their password (admin/owner only).
    app.patch('/api/v1/users/:id', async (req, reply) => {
        const { accountId, userId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can edit people.' });
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({
            name: z.string().trim().min(1).max(100).optional(),
            role: z.enum(['admin', 'member']).optional(),
            isActive: z.boolean().optional(),
            password: z.string().min(8).max(200).optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [target] = await db.select().from(users)
            .where(tenantWhere(users, accountId, eq(users.id, id))).limit(1);
        if (!target)
            return reply.code(404).send({ error: 'Person not found.' });
        if (target.role === 'owner' && (parsed.data.role || parsed.data.isActive === false)) {
            return reply.code(403).send({ error: 'The workspace owner cannot be demoted or deactivated.' });
        }
        // Never leave the workspace with zero active admins.
        if ((parsed.data.isActive === false || parsed.data.role === 'member') && target.role !== 'member') {
            if (await activeAdminCount(accountId, id) === 0) {
                return reply.code(400).send({ error: 'There must be at least one active admin.' });
            }
        }
        if (parsed.data.isActive === false && id === userId) {
            return reply.code(400).send({ error: "You can't deactivate yourself." });
        }
        const patch = {};
        if (parsed.data.name !== undefined)
            patch.name = parsed.data.name;
        if (parsed.data.role !== undefined)
            patch.role = parsed.data.role;
        if (parsed.data.isActive !== undefined)
            patch.isActive = parsed.data.isActive;
        if (parsed.data.password) {
            patch.passwordHash = await hashPassword(parsed.data.password);
            patch.failedAttempts = 0;
            patch.lockedUntil = null;
        }
        await db.update(users).set(patch).where(tenantWhere(users, accountId, eq(users.id, id)));
        const [updated] = await db.select().from(users).where(tenantWhere(users, accountId, eq(users.id, id))).limit(1);
        return { user: updated ? publicUser(updated) : null };
    });
}
//# sourceMappingURL=users.js.map