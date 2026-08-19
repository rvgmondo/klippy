import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { formatMoney } from './currency.js';
import { db } from '../db/client.js';
import { tasks, users, boards, folders, memberships, subscriptions, documents, payments, accounts, jobRuns, businesses, deals, events } from '../db/schema.js';
import { sendMail, sendBusinessMail, emailBrandFor, appUrl } from './mailer.js';
import { renderEmail, renderEmailText } from './emailLayout.js';
import { payLinkFor } from './paylink.js';
import { addDays, addMonths, anchorDayOf, generateSubscriptionInvoice } from './billing.js';
import { attemptAutoDebit } from './autoDebit.js';
import { mrrByCurrency } from './mrr.js';
import { runHostingSuspensions } from './hosting.js';
import { pruneLoginTokens } from './portalAuth.js';
/**
 * The app's daily jobs, and the scheduler that runs them.
 *
 * These used to be reachable only through HTTP endpoints that someone had to wire
 * to an external cron. That is a chore on shared hosting and a non-starter if this
 * is ever sold, since every customer would have to do it. So the work lives here
 * and the app runs it itself; the endpoints remain for triggering a run by hand.
 *
 * Each job is once a day and sweeps every account, so runs are tracked by date in
 * `job_runs` rather than per tenant.
 */
const todayStr = () => new Date().toISOString().slice(0, 10);
export const JOBS = [
    {
        name: 'bill-subscriptions',
        label: 'Recurring billing',
        description: 'Raises invoices for subscriptions that have come due, and sends them if the client has a billing email and auto-send is on.',
        hour: 6,
    },
    {
        name: 'daily-digest',
        label: 'Morning digest',
        description: 'Emails you what is due today and what is overdue. Only to people who have it switched on, and only when there is something to say.',
        hour: 7,
    },
    {
        name: 'hosting-suspensions',
        label: 'Hosting suspensions',
        // Last of the day, so an invoice paid this morning has already been counted and
        // nobody is suspended over money that has arrived.
        description: 'Warns clients whose hosting invoices are overdue, then suspends the account once it is past the limit. Off unless a number of days is set.',
        hour: 9,
    },
    {
        name: 'deal-follow-ups',
        label: 'Follow-up reminders',
        description: 'Emails you the deals you said you would chase today, and the ones you said you would chase and did not.',
        hour: 7,
    },
    {
        name: 'finance-digest',
        label: 'Weekly money digest',
        description: 'On Monday mornings, emails owners the week\'s money: invoiced, received, MRR, and what is still owed.',
        hour: 7,
    },
    {
        name: 'invoice-reminders',
        label: 'Payment reminders',
        // Runs after billing so invoices raised this morning are included.
        description: 'Chases unpaid invoices: three days before due, on the due date, then weekly once overdue.',
        hour: 8,
    },
];
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
    if (today.length)
        parts.push(`DUE TODAY (${today.length}):`, ...today.map(line), '');
    if (!overdue.length && !today.length)
        parts.push('Nothing due today and nothing overdue. Enjoy it.', '');
    parts.push(`Open Klippy: ${appUrl()}`, '', 'To stop these, turn off the daily digest in Settings > Profile.');
    return parts.join('\n');
}
export async function runDailyDigest() {
    const today = todayStr();
    // Spent and expired portal sign-in links are rubbish after a week. Nothing ever
    // deleted them, so the table only grew; hung off the digest because it already
    // runs once a day and this is not worth a schedule of its own.
    await pruneLoginTokens().catch(() => { });
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
        await sendMail(u.email, subject, renderDigest(u.name, dueToday, overdue));
        sent++;
    }
    return `${sent} sent of ${recipients.length} considered`;
}
/**
 * The Monday money digest.
 *
 * Runs in the daily sweep but only does anything on a Monday, so a founder gets one
 * email a week that answers "how did the business do?" without opening anything:
 * invoiced, received, current MRR, and what is still owed. Only to owners/admins who
 * have the digest switched on, and grouped by workspace so the figures are computed
 * once per account rather than once per recipient.
 *
 * Money is grouped by currency and never summed across, same rule as everywhere.
 */
export async function runFinanceDigest() {
    // getUTCDay: 0 Sun, 1 Mon. Only Mondays send; other days record a clean skip.
    if (new Date().getUTCDay() !== 1)
        return 'Not Monday; nothing sent.';
    const weekAgo = addDays(todayStr(), -7);
    const recipients = await db.select({
        id: users.id, name: users.name, email: users.email, accountId: memberships.accountId,
    }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(users.isActive, true), eq(users.dailyDigest, true), eq(memberships.isActive, true), inArray(memberships.role, ['owner', 'admin'])));
    // Group recipients by account so the money is computed once per workspace.
    const byAccount = new Map();
    for (const r of recipients) {
        const list = byAccount.get(r.accountId) ?? [];
        list.push(r);
        byAccount.set(r.accountId, list);
    }
    const round = (n) => Math.round(n * 100) / 100;
    let sent = 0;
    for (const [accountId, people] of byAccount) {
        const [acc] = await db.select({ currency: accounts.currency }).from(accounts)
            .where(eq(accounts.id, accountId)).limit(1);
        const wsCur = acc?.currency || 'ZAR';
        // Invoiced and received in the last 7 days, grouped by the document currency.
        const invRows = await db.select({ currency: documents.currency, total: documents.total })
            .from(documents)
            .where(and(eq(documents.accountId, accountId), eq(documents.type, 'invoice'), ne(documents.status, 'void'), ne(documents.status, 'draft'), gte(documents.issueDate, weekAgo)));
        const payRows = await db.select({ amount: payments.amount, currency: documents.currency })
            .from(payments).innerJoin(documents, eq(documents.id, payments.documentId))
            .where(and(eq(payments.accountId, accountId), gte(payments.paidOn, weekAgo)));
        const owedRows = await db.select({ currency: documents.currency, total: documents.total })
            .from(documents)
            .where(and(eq(documents.accountId, accountId), eq(documents.type, 'invoice'), eq(documents.status, 'sent')));
        const bucket = new Map();
        const into = (c) => { let b = bucket.get(c); if (!b) {
            b = { invoiced: 0, received: 0, owed: 0 };
            bucket.set(c, b);
        } return b; };
        for (const r of invRows)
            into(r.currency).invoiced += Number(r.total);
        for (const r of payRows)
            into(r.currency).received += Number(r.amount);
        for (const r of owedRows)
            into(r.currency).owed += Number(r.total);
        const mrr = await mrrByCurrency(accountId);
        for (const m of mrr)
            into(m.currency); // ensure the currency shows even if quiet this week
        const rows = [...bucket].map(([currency, b]) => {
            const m = mrr.find((x) => x.currency === currency);
            return { currency, invoiced: round(b.invoiced), received: round(b.received), owed: round(b.owed), mrr: m?.mrr ?? 0 };
        });
        if (!rows.length)
            continue; // a workspace with no money activity gets no mail
        const facts = [];
        for (const r of rows) {
            facts.push([`Invoiced (${r.currency})`, formatMoney(r.invoiced, r.currency)]);
            facts.push([`Received (${r.currency})`, formatMoney(r.received, r.currency)]);
            facts.push([`Outstanding (${r.currency})`, formatMoney(r.owed, r.currency)]);
            if (r.mrr > 0)
                facts.push([`MRR (${r.currency})`, formatMoney(r.mrr, r.currency)]);
        }
        const content = {
            heading: 'Your week in money',
            body: ['Here is where the business stood over the last seven days.'],
            facts,
            button: { label: 'Open Klippy', url: `${appUrl()}?v=reports` },
        };
        const brand = await emailBrandFor(accountId, null);
        for (const u of people) {
            await sendMail(u.email, 'Klippy: your weekly money digest', renderEmail(brand, content))
                .then(() => { sent++; })
                .catch(() => { });
        }
    }
    return `${sent} finance digest(s) sent across ${byAccount.size} workspace(s)`;
}
export async function runSubscriptionBilling() {
    const today = todayStr();
    const due = await db.select().from(subscriptions)
        .where(and(eq(subscriptions.status, 'active'), lte(subscriptions.nextBillDate, today)));
    let billed = 0;
    let failed = 0;
    let debited = 0;
    let skipped = 0;
    for (const sub of due) {
        // Claim THIS cycle before billing it: advance nextBillDate only while it still
        // equals the date we read. Two overlapping runs (or a manual re-run after the
        // scheduled one) both see the same due subscription, but only the first advance
        // matches; the second finds affectedRows 0 and skips. So a cycle is invoiced and
        // charged at most once, even if the job-level guard is somehow bypassed. Claiming
        // BEFORE billing means a crash mid-invoice skips the cycle (visible, recoverable)
        // rather than risking a second charge.
        const nextDate = addMonths(sub.nextBillDate, sub.intervalMonths ?? 1, anchorDayOf(sub.startedOn));
        const claim = await db.update(subscriptions)
            .set({ nextBillDate: nextDate, lastBilledAt: new Date() })
            .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.nextBillDate, sub.nextBillDate), eq(subscriptions.status, 'active')));
        if (!claim[0].affectedRows) {
            skipped++;
            continue;
        }
        try {
            const docId = await generateSubscriptionInvoice(sub.accountId, {
                businessId: sub.businessId, offeringId: sub.offeringId, folderId: sub.folderId,
                createdBy: sub.createdBy, autoSend: sub.autoSend, subscriptionId: sub.id,
                price: sub.price != null ? Number(sub.price) : null,
            });
            // Then try to take the money, if this subscription is set up for it. Every
            // guard lives in attemptAutoDebit; it returns "skipped" for the ordinary case
            // where auto-debit is off, and a failure to charge must never undo the
            // invoice or stop the rest of the run.
            try {
                const [raised] = await db.select({
                    total: documents.total, number: documents.number, currency: documents.currency,
                }).from(documents).where(eq(documents.id, docId)).limit(1);
                if (raised) {
                    const res = await attemptAutoDebit({
                        accountId: sub.accountId, businessId: sub.businessId, subscriptionId: sub.id,
                        documentId: docId, amount: Number(raised.total), currency: raised.currency,
                        itemName: `Invoice ${raised.number}`, invoiceNumber: raised.number,
                    });
                    if (res.outcome === 'charged')
                        debited++;
                }
            }
            catch { /* the invoice stands; the charge can be retried by hand */ }
            // nextBillDate was already advanced by the atomic claim above.
            billed++;
        }
        catch (err) {
            // A subscription that fails to bill used to increment a counter and lose the
            // reason entirely: the morning summary said "1 failed" and there was nowhere
            // to find out why. Recorded where the rest of the money trail is read.
            failed++;
            await db.insert(events).values({
                accountId: sub.accountId, businessId: sub.businessId, name: 'billing.failed',
                payload: {
                    subscriptionId: sub.id, offeringId: sub.offeringId, folderId: sub.folderId,
                    detail: err instanceof Error ? err.message : String(err),
                },
                results: [{
                        handler: 'bill-subscriptions',
                        outcome: `Could not raise this cycle's invoice: ${err instanceof Error ? err.message : String(err)}`,
                        ok: false,
                    }],
            }).catch(() => { });
        }
    }
    return `${billed} invoiced of ${due.length} due${debited ? `, ${debited} auto-debited` : ''}${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} already billed (skipped)` : ''}`;
}
/**
 * Tell people what they said they would chase.
 *
 * Deals rarely die on a no. They die because a follow-up date passed and nobody
 * noticed, and after a fortnight it feels too late to ask. So overdue ones are
 * listed first and by how late they are, because the awkward ones are exactly the
 * ones worth reviving.
 *
 * Sent to whoever created the deal, since they are the one holding the thread.
 */
export async function runDealFollowUps() {
    const today = todayStr();
    const due = await db.select({
        id: deals.id, title: deals.title, company: deals.company, stage: deals.stage,
        value: deals.value, accountId: deals.accountId, businessId: deals.businessId,
        createdBy: deals.createdBy, nextFollowUpAt: deals.nextFollowUpAt,
        followUpNote: deals.followUpNote,
    }).from(deals)
        .where(and(isNotNull(deals.nextFollowUpAt), lte(deals.nextFollowUpAt, today), inArray(deals.stage, ['lead', 'contacted', 'proposal'])));
    if (!due.length)
        return 'nothing due';
    // One email per person, not one per deal. Five separate reminders at 7am is how
    // a useful nudge becomes something you filter to a folder.
    const byUser = new Map();
    for (const d of due) {
        if (!d.createdBy)
            continue;
        const list = byUser.get(d.createdBy) ?? [];
        list.push(d);
        byUser.set(d.createdBy, list);
    }
    let sent = 0;
    for (const [userId, list] of byUser) {
        const [u] = await db.select({ email: users.email, name: users.name }).from(users)
            .where(and(eq(users.id, userId), eq(users.isActive, true))).limit(1);
        if (!u)
            continue;
        list.sort((a, b) => (a.nextFollowUpAt ?? '').localeCompare(b.nextFollowUpAt ?? ''));
        const lines = list.map((d) => {
            const late = daysBetween(today, d.nextFollowUpAt);
            const when = late === 0 ? 'today' : `${late} day${late === 1 ? '' : 's'} ago`;
            const who = d.company ? ` (${d.company})` : '';
            return `  - ${d.title}${who} - due ${when}${d.followUpNote ? `: ${d.followUpNote}` : ''}`;
        });
        const overdue = list.filter((d) => daysBetween(today, d.nextFollowUpAt) > 0).length;
        const body = [
            `Morning ${u.name},`,
            '',
            overdue
                ? `${list.length} to follow up, ${overdue} of them already overdue:`
                : `${list.length} to follow up today:`,
            ...lines,
            '',
            `Open the pipeline: ${appUrl()}`,
            '',
            'To stop these, clear the follow-up date on a deal.',
        ].join('\n');
        await sendMail(u.email, `Klippy: ${list.length} to follow up${overdue ? `, ${overdue} overdue` : ''}`, body);
        sent++;
    }
    return `${sent} sent for ${due.length} deals due`;
}
/** The reminder schedule to use when a business has not set its own. */
export const DEFAULT_REMINDER_OFFSETS = [-3, 0, 7];
const daysBetween = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
export async function runInvoiceReminders() {
    const today = todayStr();
    const rows = await db.select().from(documents).where(and(eq(documents.type, 'invoice'), eq(documents.status, 'sent'), // draft = not sent yet, paid/void = done
    isNotNull(documents.dueDate), isNotNull(documents.clientEmail)));
    // Each invoice is chased on its own business's schedule, so cache the schedule
    // per business rather than re-reading it for every invoice.
    const bizCache = new Map();
    async function scheduleFor(businessId) {
        if (businessId == null)
            return { enabled: true, offsets: DEFAULT_REMINDER_OFFSETS, suspendAfter: null, brand: 'Accounts' };
        const cached = bizCache.get(businessId);
        if (cached)
            return cached;
        const [b] = await db.select({
            remindersEnabled: businesses.remindersEnabled, reminderOffsets: businesses.reminderOffsets,
            suspendAfterDays: businesses.suspendAfterDays, brandName: businesses.brandName, name: businesses.name,
        }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
        const cfg = {
            enabled: b?.remindersEnabled ?? true,
            offsets: (b?.reminderOffsets && b.reminderOffsets.length ? b.reminderOffsets : DEFAULT_REMINDER_OFFSETS),
            suspendAfter: b?.suspendAfterDays ?? null,
            brand: b?.brandName || b?.name || 'Accounts',
        };
        bizCache.set(businessId, cfg);
        return cfg;
    }
    let sent = 0;
    let suspended = 0;
    for (const doc of rows) {
        const cfg = await scheduleFor(doc.businessId);
        if (!cfg.enabled)
            continue;
        if (doc.lastReminderOn === today)
            continue; // never twice in a day
        const overdueBy = -daysBetween(doc.dueDate, today); // >0 means overdue
        // A chase with a button that takes the payment is worth far more than one
        // asking them to go and find the invoice. Null when PayFast is not set up.
        const payLink = await payLinkFor(doc.accountId, doc.id).catch(() => null);
        // Suspension supersedes a normal reminder: once far enough overdue and not yet
        // flagged, send the final notice and mark it, so the Collections list shows it.
        if (cfg.suspendAfter != null && overdueBy >= cfg.suspendAfter && !doc.suspendedAt) {
            const emailBrand = await emailBrandFor(doc.accountId, doc.businessId);
            const content = {
                heading: `Invoice ${doc.number} is ${overdueBy} days overdue`,
                body: [
                    `Hi ${doc.clientName},`,
                    `Invoice ${doc.number} has not been paid and is now ${overdueBy} days past its due date.`,
                    'To avoid any interruption to your service, please settle it as soon as possible.',
                ],
                facts: [
                    ['Amount', formatMoney(doc.total, doc.currency)],
                    ['Was due', doc.dueDate],
                    ['Days overdue', String(overdueBy)],
                ],
                ...(payLink ? { button: { label: 'Pay now', url: payLink } } : {}),
                note: 'If you have already paid, please let us know so we can update our records.',
            };
            try {
                await sendBusinessMail({
                    accountId: doc.accountId, businessId: doc.businessId, purpose: 'invoice',
                    to: doc.clientEmail, subject: `Action needed: invoice ${doc.number} overdue`,
                    text: renderEmailText(emailBrand, content), html: renderEmail(emailBrand, content),
                });
                await db.update(documents).set({ lastReminderOn: today, suspendedAt: new Date() })
                    .where(and(eq(documents.accountId, doc.accountId), eq(documents.id, doc.id)));
                suspended++;
            }
            catch { /* retry next run */ }
            continue;
        }
        // A normal reminder is due when today has reached one of the scheduled dates
        // (dueDate + offset) that we have not already passed. Using "<= today and later
        // than the last reminder" means a missed day is caught up rather than skipped.
        const scheduledDates = cfg.offsets.map((o) => addDays(doc.dueDate, o)).sort();
        const dueNow = scheduledDates.filter((d) => daysBetween(d, today) <= 0
            && (!doc.lastReminderOn || daysBetween(doc.lastReminderOn, d) > 0));
        if (dueNow.length === 0)
            continue;
        const subject = overdueBy > 0 ? `Overdue: invoice ${doc.number}`
            : overdueBy === 0 ? `Invoice ${doc.number} is due today`
                : `Reminder: invoice ${doc.number} is due soon`;
        const emailBrand = await emailBrandFor(doc.accountId, doc.businessId);
        const content = {
            heading: subject,
            body: [
                `Hi ${doc.clientName},`,
                overdueBy > 0
                    ? `Invoice ${doc.number} was due on ${doc.dueDate}, ${overdueBy} day${overdueBy === 1 ? '' : 's'} ago.`
                    : `This is a reminder that invoice ${doc.number} is due on ${doc.dueDate}.`,
            ],
            facts: [
                ['Amount', formatMoney(doc.total, doc.currency)],
                [overdueBy > 0 ? 'Was due' : 'Due', doc.dueDate],
            ],
            ...(payLink ? { button: { label: 'Pay now', url: payLink } } : {}),
            note: 'If it is already paid, please ignore this.',
        };
        try {
            await sendBusinessMail({
                accountId: doc.accountId, businessId: doc.businessId, purpose: 'invoice',
                to: doc.clientEmail, subject,
                text: renderEmailText(emailBrand, content), html: renderEmail(emailBrand, content),
            });
            await db.update(documents).set({ lastReminderOn: today })
                .where(and(eq(documents.accountId, doc.accountId), eq(documents.id, doc.id)));
            sent++;
        }
        catch { /* try again on the next run */ }
    }
    return `${sent} chased, ${suspended} flagged, of ${rows.length} unpaid`;
}
/** dateStr + n days, as YYYY-MM-DD. */
const RUNNERS = {
    'daily-digest': runDailyDigest,
    'bill-subscriptions': runSubscriptionBilling,
    'hosting-suspensions': runHostingSuspensions,
    'deal-follow-ups': runDealFollowUps,
    'finance-digest': runFinanceDigest,
    'invoice-reminders': runInvoiceReminders,
};
/** Run one job now and record the outcome, whatever it is. */
export async function runJob(name) {
    let ok = true;
    let message = '';
    try {
        message = await RUNNERS[name]();
    }
    catch (err) {
        ok = false;
        message = err instanceof Error ? err.message : 'Failed';
    }
    const row = { lastRunOn: todayStr(), lastRunAt: new Date(), lastStatus: ok ? 'ok' : 'failed', lastMessage: message.slice(0, 500) };
    const [existing] = await db.select().from(jobRuns).where(eq(jobRuns.name, name)).limit(1);
    if (existing)
        await db.update(jobRuns).set(row).where(eq(jobRuns.name, name));
    else
        await db.insert(jobRuns).values({ name, ...row });
    return { ok, message };
}
/**
 * Run anything that is due and has not run today. Called on boot and on a timer.
 *
 * Passenger stops an idle app, so a timer alone is not dependable: this also runs at
 * startup, which means the next visit to the site catches up anything missed. Jobs
 * only fire once their hour has passed, so a restart at midnight does not send the
 * morning digest early.
 */
/**
 * Claim a job for today, atomically, so only ONE caller ever runs it.
 *
 * The old guard read lastRunOn and then ran the job, writing lastRunOn only when
 * the job finished. `/automation/tick` fires on every app load, and Passenger runs
 * several workers, so two ticks a few milliseconds apart both read "not run yet"
 * and both billed the same cycle and charged the same card. This closes that: the
 * conditional UPDATE is a single atomic row operation, so of two concurrent callers
 * exactly one flips lastRunOn to today (affectedRows 1) and the other matches
 * nothing (affectedRows 0) and backs off.
 *
 * lastRunOn is stamped here, BEFORE the work, on purpose: a job that crashes must
 * not be retried by the next tick and bill twice. A missed run waits for tomorrow
 * (or a manual trigger), which is the safe direction for money.
 */
async function claimJobForToday(name, today) {
    // Make sure a row exists to update (first run of a fresh install).
    await db.insert(jobRuns).values({ name }).onDuplicateKeyUpdate({ set: { name } });
    const res = await db.update(jobRuns)
        .set({ lastRunOn: today, lastRunAt: new Date() })
        .where(and(eq(jobRuns.name, name), or(isNull(jobRuns.lastRunOn), ne(jobRuns.lastRunOn, today))));
    return res[0].affectedRows > 0;
}
export async function runDueJobs() {
    const today = todayStr();
    const hour = new Date().getHours();
    const state = await db.select().from(jobRuns);
    const byName = new Map(state.map((s) => [s.name, s]));
    for (const job of JOBS) {
        const s = byName.get(job.name);
        if (s && s.enabled === false)
            continue;
        if (s?.lastRunOn === today)
            continue; // cheap fast path; the claim is the real gate
        if (hour < job.hour)
            continue;
        // Only the caller that wins the atomic claim runs the job.
        if (!(await claimJobForToday(job.name, today)))
            continue;
        await runJob(job.name);
    }
}
let timer = null;
/** Start the in-process scheduler. Checks every 15 minutes; harmless if it overlaps. */
export function startScheduler() {
    if (timer)
        return;
    const tick = () => {
        runDueJobs().catch((err) => {
            // eslint-disable-next-line no-console
            console.error('klippy-api scheduler tick failed:', err);
        });
    };
    // A moment after boot, so it does not compete with the first requests.
    setTimeout(tick, 20_000);
    timer = setInterval(tick, 15 * 60_000);
    // Do not hold the process open on its own account.
    timer.unref?.();
}
//# sourceMappingURL=jobs.js.map