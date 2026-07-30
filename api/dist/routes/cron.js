import { and, eq, isNotNull, lt, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, users, boards, folders, memberships, subscriptions } from '../db/schema.js';
import { sendMail, appUrl } from '../lib/mailer.js';
import { addOneMonth, generateSubscriptionInvoice } from '../lib/billing.js';
const todayStr = () => new Date().toISOString().slice(0, 10);
function renderDigest(name, today, overdue) {
    const line = (t) => {
        const where = [t.folderName, t.boardName].filter(Boolean).join(' / ');
        const pri = t.priority !== 'none' ? ` [${t.priority}]` : '';
        return `  - ${t.title}${pri}${where ? `  (${where})` : ''}`;
    };
    const parts = [`Morning ${name},`, ''];
    if (overdue.length) {
        parts.push(`OVERDUE (${overdue.length}):`, ...overdue.map((t) => `${line(t)}  - was due ${t.dueDate}`), '');
    }
    if (today.length) {
        parts.push(`DUE TODAY (${today.length}):`, ...today.map(line), '');
    }
    if (!overdue.length && !today.length)
        parts.push('Nothing due today and nothing overdue. Enjoy it.', '');
    parts.push(`Open Klippy: ${appUrl()}`, '', 'To stop these, turn off the daily digest in Settings > Profile.');
    return parts.join('\n');
}
export async function cronRoutes(app) {
    /**
     * Morning digest. Called by a cPanel cron job, authenticated with a shared
     * secret (CRON_SECRET) since there is no logged-in user:
     *   curl -s -H "X-Cron-Key: SECRET" https://your-site/api/v1/cron/daily-digest
     */
    app.post('/api/v1/cron/daily-digest', async (req, reply) => {
        const secret = process.env.CRON_SECRET;
        if (!secret)
            return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
        const given = req.headers['x-cron-key'] ?? '';
        if (given !== secret)
            return reply.code(401).send({ error: 'Bad cron key.' });
        const today = todayStr();
        // One row per (person, workspace) so someone in two workspaces gets each.
        const recipients = await db.select({
            id: users.id, name: users.name, email: users.email, accountId: memberships.accountId,
        }).from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(and(eq(users.isActive, true), eq(users.dailyDigest, true), eq(memberships.isActive, true)));
        let sent = 0;
        for (const u of recipients) {
            const base = and(eq(tasks.accountId, u.accountId), eq(tasks.isArchived, false), eq(tasks.isCompleted, false), isNotNull(tasks.dueDate));
            const select = () => db.select({
                id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, priority: tasks.priority,
                boardName: boards.name, folderName: folders.name,
            }).from(tasks)
                .leftJoin(boards, eq(boards.id, tasks.boardId))
                .leftJoin(folders, eq(folders.id, boards.folderId));
            const dueToday = await select().where(and(base, eq(tasks.dueDate, today))).limit(50);
            const overdue = await select().where(and(base, lt(tasks.dueDate, today))).limit(50);
            if (!dueToday.length && !overdue.length)
                continue; // don't nag with empty mail
            const subject = overdue.length
                ? `Klippy: ${dueToday.length} due today, ${overdue.length} overdue`
                : `Klippy: ${dueToday.length} due today`;
            try {
                await sendMail(u.email, subject, renderDigest(u.name, dueToday, overdue));
                sent++;
            }
            catch (err) {
                req.log.error({ err, to: u.email }, 'digest send failed');
            }
        }
        return { ok: true, considered: recipients.length, sent };
    });
    /**
     * Recurring billing. Generates a draft invoice for every active subscription whose
     * next_bill_date has arrived, across every account (there's no logged-in user here,
     * same pattern as the digest above), then rolls next_bill_date forward a month.
     * Called by a cPanel cron job, same auth as the digest:
     *   curl -s -X POST -H "X-Cron-Key: SECRET" https://your-site/api/v1/cron/bill-subscriptions
     */
    app.post('/api/v1/cron/bill-subscriptions', async (req, reply) => {
        const secret = process.env.CRON_SECRET;
        if (!secret)
            return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
        const given = req.headers['x-cron-key'] ?? '';
        if (given !== secret)
            return reply.code(401).send({ error: 'Bad cron key.' });
        const today = todayStr();
        const due = await db.select().from(subscriptions)
            .where(and(eq(subscriptions.status, 'active'), lte(subscriptions.nextBillDate, today)));
        let billed = 0;
        let failed = 0;
        for (const sub of due) {
            try {
                await generateSubscriptionInvoice(sub.accountId, {
                    businessId: sub.businessId, offeringId: sub.offeringId, folderId: sub.folderId,
                    createdBy: sub.createdBy,
                });
                await db.update(subscriptions).set({
                    nextBillDate: addOneMonth(sub.nextBillDate), lastBilledAt: new Date(),
                }).where(eq(subscriptions.id, sub.id));
                billed++;
            }
            catch (err) {
                req.log.error({ err, subscriptionId: sub.id }, 'subscription billing failed');
                failed++;
            }
        }
        return { ok: true, due: due.length, billed, failed };
    });
}
//# sourceMappingURL=cron.js.map