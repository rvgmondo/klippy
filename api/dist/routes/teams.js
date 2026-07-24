import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { teams, teamMembers, boardTeams, users, boards } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
export async function teamRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // All teams with their members (small data; one extra query keeps it simple).
    app.get('/api/v1/teams', async (req) => {
        const { accountId } = authOf(req);
        const rows = await db.select().from(teams)
            .where(tenantWhere(teams, accountId)).orderBy(teams.name);
        const members = await db.select({
            teamId: teamMembers.teamId, userId: teamMembers.userId,
            name: users.name, email: users.email,
        }).from(teamMembers)
            .leftJoin(users, eq(users.id, teamMembers.userId))
            .where(tenantWhere(teamMembers, accountId));
        return {
            teams: rows.map((t) => ({
                ...t,
                members: members.filter((m) => m.teamId === t.id).map(({ userId, name, email }) => ({ userId, name, email })),
            })),
        };
    });
    app.post('/api/v1/teams', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can create teams.' });
        const parsed = z.object({
            name: z.string().trim().min(1).max(80),
            color: z.string().trim().max(20).optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const ins = await db.insert(teams).values(withTenant(accountId, {
            name: parsed.data.name, color: parsed.data.color ?? '#6366f1',
        }));
        const [created] = await db.select().from(teams)
            .where(tenantWhere(teams, accountId, eq(teams.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ team: created });
    });
    app.patch('/api/v1/teams/:id', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can edit teams.' });
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({
            name: z.string().trim().min(1).max(80).optional(),
            color: z.string().trim().max(20).optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const res = await db.update(teams).set(parsed.data)
            .where(tenantWhere(teams, accountId, eq(teams.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Team not found.' });
        const [updated] = await db.select().from(teams)
            .where(tenantWhere(teams, accountId, eq(teams.id, id))).limit(1);
        return { team: updated };
    });
    app.delete('/api/v1/teams/:id', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can delete teams.' });
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const res = await db.delete(teams).where(tenantWhere(teams, accountId, eq(teams.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Team not found.' });
        return { ok: true };
    });
    // Add / remove a person on a team.
    app.post('/api/v1/teams/:id/members', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can change teams.' });
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({ userId: z.number().int().positive() }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'userId required.' });
        const [team] = await db.select({ id: teams.id }).from(teams)
            .where(tenantWhere(teams, accountId, eq(teams.id, id))).limit(1);
        if (!team)
            return reply.code(404).send({ error: 'Team not found.' });
        const [member] = await db.select({ id: users.id }).from(users)
            .where(tenantWhere(users, accountId, eq(users.id, parsed.data.userId))).limit(1);
        if (!member)
            return reply.code(400).send({ error: 'Person not found.' });
        const [existing] = await db.select({ id: teamMembers.id }).from(teamMembers)
            .where(tenantWhere(teamMembers, accountId, and(eq(teamMembers.teamId, id), eq(teamMembers.userId, parsed.data.userId)))).limit(1);
        if (!existing) {
            await db.insert(teamMembers).values(withTenant(accountId, { teamId: id, userId: parsed.data.userId }));
        }
        return { ok: true };
    });
    app.delete('/api/v1/teams/:id/members/:userId', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can change teams.' });
        const id = intId(req);
        const userId = intId(req, 'userId');
        if (!id || !userId)
            return reply.code(400).send({ error: 'Bad id.' });
        await db.delete(teamMembers)
            .where(tenantWhere(teamMembers, accountId, and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId))));
        return { ok: true };
    });
    // Attach / detach a team to a board.
    app.get('/api/v1/boards/:id/teams', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const rows = await db.select({ teamId: boardTeams.teamId, name: teams.name, color: teams.color })
            .from(boardTeams)
            .leftJoin(teams, eq(teams.id, boardTeams.teamId))
            .where(tenantWhere(boardTeams, accountId, eq(boardTeams.boardId, id)));
        return { teams: rows };
    });
    app.post('/api/v1/boards/:id/teams', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can change board teams.' });
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({ teamId: z.number().int().positive() }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'teamId required.' });
        const [board] = await db.select({ id: boards.id }).from(boards)
            .where(tenantWhere(boards, accountId, eq(boards.id, id))).limit(1);
        if (!board)
            return reply.code(404).send({ error: 'Board not found.' });
        const [team] = await db.select({ id: teams.id }).from(teams)
            .where(tenantWhere(teams, accountId, eq(teams.id, parsed.data.teamId))).limit(1);
        if (!team)
            return reply.code(400).send({ error: 'Team not found.' });
        const [existing] = await db.select({ id: boardTeams.id }).from(boardTeams)
            .where(tenantWhere(boardTeams, accountId, and(eq(boardTeams.boardId, id), eq(boardTeams.teamId, parsed.data.teamId)))).limit(1);
        if (!existing) {
            await db.insert(boardTeams).values(withTenant(accountId, { boardId: id, teamId: parsed.data.teamId }));
        }
        return { ok: true };
    });
    app.delete('/api/v1/boards/:id/teams/:teamId', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can change board teams.' });
        const id = intId(req);
        const teamId = intId(req, 'teamId');
        if (!id || !teamId)
            return reply.code(400).send({ error: 'Bad id.' });
        await db.delete(boardTeams)
            .where(tenantWhere(boardTeams, accountId, and(eq(boardTeams.boardId, id), eq(boardTeams.teamId, teamId))));
        return { ok: true };
    });
}
//# sourceMappingURL=teams.js.map