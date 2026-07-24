import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { productNotes, users } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
const kind = z.enum(['idea', 'bug', 'improvement', 'question']);
const status = z.enum(['open', 'planned', 'done', 'dropped']);
const priority = z.enum(['low', 'medium', 'high']);
export async function noteRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/notes', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Admins only.' });
        const rows = await db.select({
            id: productNotes.id, title: productNotes.title, body: productNotes.body,
            kind: productNotes.kind, status: productNotes.status, priority: productNotes.priority,
            createdAt: productNotes.createdAt, authorName: users.name,
        }).from(productNotes)
            .leftJoin(users, eq(users.id, productNotes.createdBy))
            .where(tenantWhere(productNotes, accountId))
            .orderBy(desc(productNotes.createdAt));
        return { notes: rows };
    });
    app.post('/api/v1/notes', async (req, reply) => {
        const { accountId, userId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Admins only.' });
        const parsed = z.object({
            title: z.string().trim().min(1).max(200),
            body: z.string().max(10000).nullable().optional(),
            kind: kind.optional(),
            priority: priority.optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const ins = await db.insert(productNotes).values(withTenant(accountId, {
            title: parsed.data.title,
            body: parsed.data.body ?? null,
            kind: parsed.data.kind ?? 'idea',
            priority: parsed.data.priority ?? 'medium',
            createdBy: userId,
        }));
        const [created] = await db.select().from(productNotes)
            .where(tenantWhere(productNotes, accountId, eq(productNotes.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ note: created });
    });
    app.patch('/api/v1/notes/:id', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Admins only.' });
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({
            title: z.string().trim().min(1).max(200).optional(),
            body: z.string().max(10000).nullable().optional(),
            kind: kind.optional(),
            status: status.optional(),
            priority: priority.optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const res = await db.update(productNotes).set(parsed.data)
            .where(tenantWhere(productNotes, accountId, eq(productNotes.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Note not found.' });
        const [updated] = await db.select().from(productNotes)
            .where(tenantWhere(productNotes, accountId, eq(productNotes.id, id))).limit(1);
        return { note: updated };
    });
    app.delete('/api/v1/notes/:id', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Admins only.' });
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const res = await db.delete(productNotes)
            .where(tenantWhere(productNotes, accountId, eq(productNotes.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Note not found.' });
        return { ok: true };
    });
    /**
     * The whole backlog as markdown, ready to hand over in one piece.
     * Defaults to everything still outstanding.
     */
    app.get('/api/v1/notes/export', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Admins only.' });
        const q = z.object({ all: z.coerce.boolean().optional() }).safeParse(req.query);
        const includeAll = q.success && q.data.all === true;
        const rows = await db.select({
            title: productNotes.title, body: productNotes.body, kind: productNotes.kind,
            status: productNotes.status, priority: productNotes.priority,
            createdAt: productNotes.createdAt, authorName: users.name,
        }).from(productNotes)
            .leftJoin(users, eq(users.id, productNotes.createdBy))
            .where(tenantWhere(productNotes, accountId))
            .orderBy(desc(productNotes.createdAt));
        const notes = includeAll ? rows : rows.filter((n) => n.status === 'open' || n.status === 'planned');
        const lines = ['# Klippy product notes', ''];
        if (!notes.length)
            lines.push('_Nothing outstanding._');
        for (const group of ['bug', 'improvement', 'idea', 'question']) {
            const inGroup = notes.filter((n) => n.kind === group);
            if (!inGroup.length)
                continue;
            lines.push(`## ${group.charAt(0).toUpperCase()}${group.slice(1)}s (${inGroup.length})`, '');
            for (const n of inGroup) {
                lines.push(`### ${n.title}`);
                lines.push(`- priority: ${n.priority} | status: ${n.status} | added by ${n.authorName ?? 'someone'} on ${new Date(n.createdAt).toISOString().slice(0, 10)}`);
                if (n.body?.trim())
                    lines.push('', n.body.trim());
                lines.push('');
            }
        }
        reply.header('Content-Type', 'text/markdown; charset=utf-8');
        return reply.send(lines.join('\n'));
    });
}
//# sourceMappingURL=notes.js.map