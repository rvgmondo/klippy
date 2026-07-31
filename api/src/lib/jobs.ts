import { and, eq, isNotNull, lt, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, users, boards, folders, memberships, subscriptions, documents, jobRuns } from '../db/schema.js';
import { sendMail, appUrl } from './mailer.js';
import { addOneMonth, anchorDayOf, generateSubscriptionInvoice } from './billing.js';

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

export type JobName = 'daily-digest' | 'bill-subscriptions' | 'invoice-reminders';

export const JOBS: { name: JobName; label: string; description: string; hour: number }[] = [
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
    name: 'invoice-reminders',
    label: 'Payment reminders',
    // Runs after billing so invoices raised this morning are included.
    description: 'Chases unpaid invoices: three days before due, on the due date, then weekly once overdue.',
    hour: 8,
  },
];

interface Row { id: number; title: string; dueDate: string | null; priority: string; boardName: string | null; folderName: string | null }

function renderDigest(name: string, today: Row[], overdue: Row[]): string {
  const line = (t: Row) => {
    const where = [t.folderName, t.boardName].filter(Boolean).join(' / ');
    const pri = t.priority !== 'none' ? ` [${t.priority}]` : '';
    return `  - ${t.title}${pri}${where ? `  (${where})` : ''}`;
  };
  const parts = [`Morning ${name},`, ''];
  if (overdue.length) {
    parts.push(`OVERDUE (${overdue.length}):`, ...overdue.map((t) => `${line(t)}  - was due ${t.dueDate}`), '');
  }
  if (today.length) parts.push(`DUE TODAY (${today.length}):`, ...today.map(line), '');
  if (!overdue.length && !today.length) parts.push('Nothing due today and nothing overdue. Enjoy it.', '');
  parts.push(`Open Klippy: ${appUrl()}`, '', 'To stop these, turn off the daily digest in Settings > Profile.');
  return parts.join('\n');
}

export async function runDailyDigest(): Promise<string> {
  const today = todayStr();
  // One row per (person, workspace) so someone in two workspaces gets each.
  const recipients = await db.select({
    id: users.id, name: users.name, email: users.email, accountId: memberships.accountId,
  }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.isActive, true), eq(users.dailyDigest, true), eq(memberships.isActive, true)));

  let sent = 0;
  for (const u of recipients) {
    const base = and(
      eq(tasks.accountId, u.accountId), eq(tasks.isArchived, false),
      eq(tasks.isCompleted, false), isNotNull(tasks.dueDate),
    );
    const select = () => db.select({
      id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, priority: tasks.priority,
      boardName: boards.name, folderName: folders.name,
    }).from(tasks)
      .leftJoin(boards, eq(boards.id, tasks.boardId))
      .leftJoin(folders, eq(folders.id, boards.folderId));

    const dueToday = await select().where(and(base, eq(tasks.dueDate, today))).limit(50) as Row[];
    const overdue = await select().where(and(base, lt(tasks.dueDate, today))).limit(50) as Row[];
    if (!dueToday.length && !overdue.length) continue; // don't nag with empty mail

    const subject = overdue.length
      ? `Klippy: ${dueToday.length} due today, ${overdue.length} overdue`
      : `Klippy: ${dueToday.length} due today`;
    await sendMail(u.email, subject, renderDigest(u.name, dueToday, overdue));
    sent++;
  }
  return `${sent} sent of ${recipients.length} considered`;
}

export async function runSubscriptionBilling(): Promise<string> {
  const today = todayStr();
  const due = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.status, 'active'), lte(subscriptions.nextBillDate, today)));

  let billed = 0;
  let failed = 0;
  for (const sub of due) {
    try {
      await generateSubscriptionInvoice(sub.accountId, {
        businessId: sub.businessId, offeringId: sub.offeringId, folderId: sub.folderId,
        createdBy: sub.createdBy, autoSend: sub.autoSend,
      });
      await db.update(subscriptions).set({
        // Anchor on the start day so month-end bills spring back rather than drift.
        nextBillDate: addOneMonth(sub.nextBillDate, anchorDayOf(sub.startedOn)),
        lastBilledAt: new Date(),
      }).where(eq(subscriptions.id, sub.id));
      billed++;
    } catch {
      failed++;
    }
  }
  return `${billed} invoiced of ${due.length} due${failed ? `, ${failed} failed` : ''}`;
}

export async function runInvoiceReminders(): Promise<string> {
  const today = todayStr();
  const rows = await db.select().from(documents).where(and(
    eq(documents.type, 'invoice'),
    eq(documents.status, 'sent'),            // draft = not sent yet, paid/void = done
    isNotNull(documents.dueDate),
    isNotNull(documents.clientEmail),
  ));

  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

  let sent = 0;
  for (const doc of rows) {
    const untilDue = daysBetween(doc.dueDate!, today);
    const overdueBy = -untilDue;
    const chasedDaysAgo = doc.lastReminderOn ? daysBetween(today, doc.lastReminderOn) : 999;
    const shouldSend = doc.lastReminderOn !== today && (
      untilDue === 3 || untilDue === 0 || (overdueBy > 0 && chasedDaysAgo >= 7)
    );
    if (!shouldSend) continue;

    const subject = overdueBy > 0
      ? `Overdue: invoice ${doc.number}`
      : untilDue === 0 ? `Invoice ${doc.number} is due today`
        : `Invoice ${doc.number} is due in 3 days`;
    const body = [
      `Hi ${doc.clientName},`, '',
      overdueBy > 0
        ? `Invoice ${doc.number} for ${doc.currency} ${doc.total} was due on ${doc.dueDate}, ${overdueBy} day${overdueBy === 1 ? '' : 's'} ago.`
        : `This is a reminder that invoice ${doc.number} for ${doc.currency} ${doc.total} is due on ${doc.dueDate}.`,
      '', 'If it is already paid, please ignore this.', '', 'Thank you.',
    ].join('\n');

    try {
      await sendMail(doc.clientEmail!, subject, body);
      await db.update(documents).set({ lastReminderOn: today })
        .where(and(eq(documents.accountId, doc.accountId), eq(documents.id, doc.id)));
      sent++;
    } catch { /* try again on the next run */ }
  }
  return `${sent} chased of ${rows.length} unpaid`;
}

const RUNNERS: Record<JobName, () => Promise<string>> = {
  'daily-digest': runDailyDigest,
  'bill-subscriptions': runSubscriptionBilling,
  'invoice-reminders': runInvoiceReminders,
};

/** Run one job now and record the outcome, whatever it is. */
export async function runJob(name: JobName): Promise<{ ok: boolean; message: string }> {
  let ok = true;
  let message = '';
  try {
    message = await RUNNERS[name]();
  } catch (err) {
    ok = false;
    message = err instanceof Error ? err.message : 'Failed';
  }
  const row = { lastRunOn: todayStr(), lastRunAt: new Date(), lastStatus: ok ? 'ok' as const : 'failed' as const, lastMessage: message.slice(0, 500) };
  const [existing] = await db.select().from(jobRuns).where(eq(jobRuns.name, name)).limit(1);
  if (existing) await db.update(jobRuns).set(row).where(eq(jobRuns.name, name));
  else await db.insert(jobRuns).values({ name, ...row });
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
export async function runDueJobs(): Promise<void> {
  const today = todayStr();
  const hour = new Date().getHours();
  const state = await db.select().from(jobRuns);
  const byName = new Map(state.map((s) => [s.name, s]));

  for (const job of JOBS) {
    const s = byName.get(job.name);
    if (s && s.enabled === false) continue;
    if (s?.lastRunOn === today) continue;
    if (hour < job.hour) continue;
    await runJob(job.name);
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the in-process scheduler. Checks every 15 minutes; harmless if it overlaps. */
export function startScheduler(): void {
  if (timer) return;
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
