import { z } from 'zod';
import { and, asc, eq, gte, lte, or, isNull, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calendarFeeds, externalEvents } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { encryptSecret, secretsAvailable } from '../lib/secretbox.js';
import { FeedError, fetchCalendar, normaliseFeedUrl, STALE_MS, syncFeed } from '../lib/calendarFeeds.js';
import { eventsInWindow } from '../lib/ics.js';
/**
 * Calendars read in from Outlook, Google or Apple. Private to the person who
 * added them: every query here is by account AND user.
 */
export async function outsideCalendarRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    const mine = (accountId, userId) => tenantWhere(calendarFeeds, accountId, eq(calendarFeeds.userId, userId));
    const shape = (f) => ({
        id: f.id, name: f.name, host: f.urlHost, lastSyncedAt: f.lastSyncedAt, lastError: f.lastError, eventCount: f.eventCount,
    });
    app.get('/api/v1/calendar-feeds', async (req) => {
        const { accountId, userId } = authOf(req);
        const rows = await db.select().from(calendarFeeds).where(mine(accountId, userId)).orderBy(asc(calendarFeeds.createdAt));
        return { feeds: rows.map(shape) };
    });
    app.post('/api/v1/calendar-feeds', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = z.object({ url: z.string().trim().min(8).max(2000), name: z.string().trim().max(80).optional() }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Paste the calendar link.' });
        if (!secretsAvailable())
            return reply.code(503).send({ error: 'The server is missing its secret key (PAYMENTS_SECRET), so private links cannot be stored safely.' });
        const have = await db.select({ id: calendarFeeds.id }).from(calendarFeeds).where(mine(accountId, userId));
        if (have.length >= 5)
            return reply.code(400).send({ error: 'Five calendars is the limit. Remove one first.' });
        let url;
        try {
            url = normaliseFeedUrl(parsed.data.url);
            // Read it once before saving, so a wrong link is caught now, not in a silent error later.
            const text = await fetchCalendar(url.toString());
            eventsInWindow(text, new Date(), new Date(Date.now() + 86400000));
        }
        catch (err) {
            return reply.code(400).send({ error: err instanceof FeedError ? err.message : 'That calendar could not be read.' });
        }
        const name = parsed.data.name || (/outlook|office|live\.com/i.test(url.hostname) ? 'Outlook' : /google/i.test(url.hostname) ? 'Google Calendar' : /icloud|apple/i.test(url.hostname) ? 'Apple Calendar' : 'My calendar');
        const ins = await db.insert(calendarFeeds).values(withTenant(accountId, {
            userId, name, urlEnc: encryptSecret(url.toString()), urlHost: url.hostname.slice(0, 120),
        }));
        const id = Number(ins[0].insertId);
        const result = await syncFeed(id);
        const [row] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.id, id)).limit(1);
        return reply.code(201).send({ feed: shape(row), synced: result });
    });
    const own = async (req, id) => {
        const { accountId, userId } = authOf(req);
        const [f] = await db.select().from(calendarFeeds).where(and(mine(accountId, userId), eq(calendarFeeds.id, id))).limit(1);
        return f;
    };
    app.post('/api/v1/calendar-feeds/:id/refresh', async (req, reply) => {
        const id = intId(req);
        const f = id ? await own(req, id) : undefined;
        if (!f)
            return reply.code(404).send({ error: 'Not found.' });
        const result = await syncFeed(f.id);
        const [row] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.id, f.id)).limit(1);
        return { feed: shape(row), synced: result };
    });
    app.patch('/api/v1/calendar-feeds/:id', async (req, reply) => {
        const id = intId(req);
        const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(req.body);
        const f = id ? await own(req, id) : undefined;
        if (!f || !parsed.success)
            return reply.code(404).send({ error: 'Not found.' });
        await db.update(calendarFeeds).set({ name: parsed.data.name }).where(eq(calendarFeeds.id, f.id));
        return { ok: true };
    });
    app.delete('/api/v1/calendar-feeds/:id', async (req, reply) => {
        const id = intId(req);
        const f = id ? await own(req, id) : undefined;
        if (!f)
            return reply.code(404).send({ error: 'Not found.' });
        await db.delete(calendarFeeds).where(eq(calendarFeeds.id, f.id));
        return { ok: true };
    });
    /** This person's outside events in a range, for the calendar and Today. */
    app.get('/api/v1/external-events', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) required.' });
        // A calendar that has gone stale is read again in the background, so opening
        // the calendar is enough to keep it fresh even when the scheduler is asleep.
        const stale = await db.select({ id: calendarFeeds.id, last: calendarFeeds.lastSyncedAt }).from(calendarFeeds)
            .where(and(mine(accountId, userId), or(isNull(calendarFeeds.lastSyncedAt), lt(calendarFeeds.lastSyncedAt, new Date(Date.now() - STALE_MS)))));
        for (const f of stale) {
            const claim = await db.update(calendarFeeds).set({ lastSyncedAt: new Date() })
                .where(and(eq(calendarFeeds.id, f.id), f.last ? eq(calendarFeeds.lastSyncedAt, f.last) : isNull(calendarFeeds.lastSyncedAt)));
            if (claim[0].affectedRows)
                void syncFeed(f.id).catch(() => { });
        }
        // Wide enough to catch an event that started the day before and runs into the range.
        const from = new Date(`${q.data.from}T00:00:00.000Z`);
        from.setUTCDate(from.getUTCDate() - 1);
        const to = new Date(`${q.data.to}T23:59:59.999Z`);
        to.setUTCDate(to.getUTCDate() + 1);
        const rows = await db.select({
            id: externalEvents.id, title: externalEvents.title, location: externalEvents.location,
            startAt: externalEvents.startAt, endAt: externalEvents.endAt, allDay: externalEvents.allDay,
            feedId: externalEvents.feedId, feedName: calendarFeeds.name,
        }).from(externalEvents).innerJoin(calendarFeeds, eq(calendarFeeds.id, externalEvents.feedId))
            .where(and(tenantWhere(externalEvents, accountId, eq(externalEvents.userId, userId)), gte(externalEvents.startAt, from), lte(externalEvents.startAt, to)))
            .orderBy(asc(externalEvents.startAt)).limit(2000);
        return { events: rows };
    });
}
//# sourceMappingURL=calendarFeeds.js.map