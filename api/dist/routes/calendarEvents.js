import { z } from 'zod';
import { asc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calendarEvents, folders } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { businessScope, assertMaybeBusiness } from '../lib/access.js';
import { resolveBusinessId } from '../lib/business.js';
/**
 * Meetings, calls and events.
 *
 * Klippy could tell you a task was due on Thursday but not that you had a call
 * with the client at nine, which is half a diary. These carry a real start and end
 * time and can be attached to a client, so the calendar shows the day as it will
 * actually be spent rather than only what is due.
 */
const dateTime = z.string().min(10).max(40); // ISO-ish; parsed below
const kind = z.enum(['meeting', 'call', 'deadline', 'other']);
const bodySchema = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    kind: kind.optional(),
    startAt: dateTime,
    endAt: dateTime.nullable().optional(),
    allDay: z.boolean().optional(),
    location: z.string().trim().max(255).nullable().optional(),
    attendees: z.string().trim().max(2000).nullable().optional(),
    businessId: z.number().int().positive().optional(),
    folderId: z.number().int().positive().nullable().optional(),
});
/** Accept both "2026-08-10T09:00" and a full ISO string. */
function parseWhen(v) {
    const d = new Date(v.length <= 16 ? `${v}:00` : v);
    return Number.isNaN(d.getTime()) ? null : d;
}
export async function calendarEventRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // Events overlapping a date range, with the client name joined for display.
    app.get('/api/v1/calendar-events', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({
            from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            businessId: z.coerce.number().int().positive().optional(),
        }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) required.' });
        const rows = await db.select({
            id: calendarEvents.id, title: calendarEvents.title, kind: calendarEvents.kind,
            startAt: calendarEvents.startAt, endAt: calendarEvents.endAt, allDay: calendarEvents.allDay,
            location: calendarEvents.location, attendees: calendarEvents.attendees,
            description: calendarEvents.description,
            businessId: calendarEvents.businessId, folderId: calendarEvents.folderId,
            clientName: folders.name,
        }).from(calendarEvents)
            .leftJoin(folders, eq(folders.id, calendarEvents.folderId))
            .where(tenantWhere(calendarEvents, accountId, gte(calendarEvents.startAt, new Date(`${q.data.from}T00:00:00.000Z`)), lte(calendarEvents.startAt, new Date(`${q.data.to}T23:59:59.999Z`)), q.data.businessId ? eq(calendarEvents.businessId, q.data.businessId) : undefined, await businessScope(req, calendarEvents.businessId)))
            .orderBy(asc(calendarEvents.startAt));
        return { events: rows };
    });
    app.post('/api/v1/calendar-events', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        const startAt = parseWhen(d.startAt);
        if (!startAt)
            return reply.code(400).send({ error: 'Start time is not a valid date.' });
        const endAt = d.endAt ? parseWhen(d.endAt) : null;
        if (d.endAt && !endAt)
            return reply.code(400).send({ error: 'End time is not a valid date.' });
        if (endAt && endAt < startAt)
            return reply.code(400).send({ error: 'It cannot end before it starts.' });
        const businessId = await resolveBusinessId(accountId, d.businessId);
        if (!(await assertMaybeBusiness(req, reply, businessId)))
            return;
        const ins = await db.insert(calendarEvents).values(withTenant(accountId, {
            businessId, folderId: d.folderId ?? null,
            title: d.title, description: d.description ?? null, kind: d.kind ?? 'meeting',
            startAt, endAt, allDay: d.allDay ?? false,
            location: d.location ?? null, attendees: d.attendees ?? null, createdBy: userId,
        }));
        const [created] = await db.select().from(calendarEvents)
            .where(tenantWhere(calendarEvents, accountId, eq(calendarEvents.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ event: created });
    });
    app.patch('/api/v1/calendar-events/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = bodySchema.partial().safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [own] = await db.select({ businessId: calendarEvents.businessId, startAt: calendarEvents.startAt })
            .from(calendarEvents).where(tenantWhere(calendarEvents, accountId, eq(calendarEvents.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        const patch = { ...parsed.data };
        delete patch.businessId;
        if (parsed.data.startAt !== undefined) {
            const s = parseWhen(parsed.data.startAt);
            if (!s)
                return reply.code(400).send({ error: 'Start time is not a valid date.' });
            patch.startAt = s;
        }
        if (parsed.data.endAt !== undefined) {
            patch.endAt = parsed.data.endAt ? parseWhen(parsed.data.endAt) : null;
            if (parsed.data.endAt && !patch.endAt)
                return reply.code(400).send({ error: 'End time is not a valid date.' });
        }
        const start = patch.startAt ?? own.startAt;
        if (patch.endAt && patch.endAt < start) {
            return reply.code(400).send({ error: 'It cannot end before it starts.' });
        }
        await db.update(calendarEvents).set(patch)
            .where(tenantWhere(calendarEvents, accountId, eq(calendarEvents.id, id)));
        const [updated] = await db.select().from(calendarEvents)
            .where(tenantWhere(calendarEvents, accountId, eq(calendarEvents.id, id))).limit(1);
        return { event: updated };
    });
    app.delete('/api/v1/calendar-events/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [own] = await db.select({ businessId: calendarEvents.businessId }).from(calendarEvents)
            .where(tenantWhere(calendarEvents, accountId, eq(calendarEvents.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        await db.delete(calendarEvents).where(tenantWhere(calendarEvents, accountId, eq(calendarEvents.id, id)));
        return { ok: true };
    });
}
//# sourceMappingURL=calendarEvents.js.map