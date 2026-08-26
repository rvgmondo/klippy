import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, boards, folders, calendarEvents } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { accessibleBusinessIdsForUser } from '../lib/access.js';
import { signCalToken, verifyCalToken } from '../lib/secretbox.js';
import { appUrl } from '../lib/mailer.js';
import { addDays } from '../lib/billing.js';
/**
 * A personal ICS feed, so Klippy's dates live inside the calendar the person
 * already looks at. Google Calendar, Outlook and Apple Calendar all subscribe to
 * a URL; this is that URL, carrying a signed token (HMAC over account and user)
 * instead of a session, because calendar apps cannot log in.
 *
 * The feed holds the user's cards with due dates (theirs or unassigned, the same
 * rule as Today) and every calendar event, from a week back to six months out.
 */
const escText = (s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const dateStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export async function calendarFeedRoutes(app) {
    // Where do I point my calendar app? (authed)
    app.get('/api/v1/calendar/feed-url', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const token = signCalToken(accountId, userId);
        if (!token) {
            return reply.code(400).send({ error: 'The server has no PAYMENTS_SECRET configured, so signed public links are off.' });
        }
        return { url: `${appUrl()}/api/v1/public/calendar/${accountId}/${userId}.ics?t=${token}` };
    });
    // The feed itself (PUBLIC, token-gated).
    app.get('/api/v1/public/calendar/:accountId/:userId.ics', async (req, reply) => {
        const p = req.params;
        const accountId = Number(p.accountId);
        const userId = Number(p.userId);
        const t = req.query.t ?? '';
        if (!accountId || !userId || !verifyCalToken(accountId, userId, t)) {
            return reply.code(404).send({ error: 'Not found.' });
        }
        const today = new Date().toISOString().slice(0, 10);
        const from = addDays(today, -7);
        const to = addDays(today, 180);
        // The token proves who the feed is for, but not what they may see. A member
        // resolves to their accessible businesses; owners/admins to "all". Without this,
        // a member's personal feed carried every business's unassigned cards and every
        // account calendar event, tenant data their session would never show them.
        const allowed = await accessibleBusinessIdsForUser(accountId, userId);
        const bizCond = (col) => {
            if (allowed === null)
                return undefined;
            if (allowed.size === 0)
                return isNull(col);
            return or(isNull(col), inArray(col, [...allowed]));
        };
        const cards = await db.select({
            id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, isCompleted: tasks.isCompleted,
            boardName: boards.name,
        }).from(tasks)
            .leftJoin(boards, eq(boards.id, tasks.boardId))
            .leftJoin(folders, eq(folders.id, boards.folderId))
            .where(and(eq(tasks.accountId, accountId), eq(tasks.isArchived, false), eq(tasks.isCompleted, false), isNull(boards.deletedAt), isNotNull(tasks.dueDate), gte(tasks.dueDate, from), lte(tasks.dueDate, to), or(eq(tasks.assignedTo, userId), isNull(tasks.assignedTo)), bizCond(folders.businessId)));
        const evStart = new Date(`${from}T00:00:00.000Z`);
        const evEnd = new Date(`${to}T23:59:59.999Z`);
        const evs = await db.select().from(calendarEvents)
            .where(and(eq(calendarEvents.accountId, accountId), gte(calendarEvents.startAt, evStart), lte(calendarEvents.startAt, evEnd), bizCond(calendarEvents.businessId)));
        const now = dateStamp(new Date());
        const lines = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Klippy//Calendar//EN',
            'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Klippy',
        ];
        for (const c of cards) {
            const day = c.dueDate.replace(/-/g, '');
            lines.push('BEGIN:VEVENT', `UID:klippy-task-${c.id}@klippy`, `DTSTAMP:${now}`, `DTSTART;VALUE=DATE:${day}`, `SUMMARY:${escText(`${c.title}${c.boardName ? ` (${c.boardName})` : ''}`)}`, 'END:VEVENT');
        }
        for (const e of evs) {
            lines.push('BEGIN:VEVENT', `UID:klippy-event-${e.id}@klippy`, `DTSTAMP:${now}`);
            if (e.allDay) {
                lines.push(`DTSTART;VALUE=DATE:${e.startAt.toISOString().slice(0, 10).replace(/-/g, '')}`);
            }
            else {
                lines.push(`DTSTART:${dateStamp(e.startAt)}`);
                if (e.endAt)
                    lines.push(`DTEND:${dateStamp(e.endAt)}`);
            }
            lines.push(`SUMMARY:${escText(e.title)}`);
            if (e.description)
                lines.push(`DESCRIPTION:${escText(e.description)}`);
            lines.push('END:VEVENT');
        }
        lines.push('END:VCALENDAR');
        reply.header('Content-Type', 'text/calendar; charset=utf-8');
        reply.header('Content-Disposition', 'inline; filename="klippy.ics"');
        return reply.send(lines.join('\r\n') + '\r\n');
    });
}
//# sourceMappingURL=calendarFeed.js.map