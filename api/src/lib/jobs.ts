import { and, eq, inArray, isNotNull, lt, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, users, boards, folders, memberships, subscriptions, documents, jobRuns, businesses, deals } from '../db/schema.js';
import { sendMail, sendBusinessMail, emailBrandFor, appUrl } from './mailer.js';
import { renderEmail, renderEmailText } from './emailLayout.js';
import { payLinkFor } from './paylink.js';
import { addMonths, anchorDayOf, generateSubscriptionInvoice } from './billing.js';
import { attemptAutoDebit } from './autoDebit.js';
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

export type JobName = 'daily-digest' | 'bill-subscriptions' | 'invoice-reminders' | 'hosting-suspensions' | 'deal-follow-ups';

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
  // Spent and expired portal sign-in links are rubbish after a week. Nothing ever
  // deleted them, so the table only grew; hung off the digest because it already
  // runs once a day and this is not worth a schedule of its own.
  await pruneLoginTokens().catch(() => { /* never let housekeeping stop the digest */ });
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
  let debited = 0;
  for (const sub of due) {
    try {
      const docId = await generateSubscriptionInvoice(sub.accountId, {
        businessId: sub.businessId, offeringId: sub.offeringId, folderId: sub.folderId,
        createdBy: sub.createdBy, autoSend: sub.autoSend, subscriptionId: sub.id,
      });

      // Then try to take the money, if this subscription is set up for it. Every
      // guard lives in attemptAutoDebit; it returns "skipped" for the ordinary case
      // where auto-debit is off, and a failure to charge must never undo the
      // invoice or stop the rest of the run.
      try {
        const [raised] = await db.select({ total: documents.total, number: documents.number })
          .from(documents).where(eq(documents.id, docId)).limit(1);
        if (raised) {
          const res = await attemptAutoDebit({
            accountId: sub.accountId, businessId: sub.businessId, subscriptionId: sub.id,
            documentId: docId, amount: Number(raised.total),
            itemName: `Invoice ${raised.number}`, invoiceNumber: raised.number,
          });
          if (res.outcome === 'charged') debited++;
        }
      } catch { /* the invoice stands; the charge can be retried by hand */ }

      await db.update(subscriptions).set({
        // Advance by the subscription's own interval (monthly, quarterly, annual),
        // anchored on the start day so month-end bills spring back rather than drift.
        nextBillDate: addMonths(sub.nextBillDate, sub.intervalMonths ?? 1, anchorDayOf(sub.startedOn)),
        lastBilledAt: new Date(),
      }).where(eq(subscriptions.id, sub.id));
      billed++;
    } catch {
      failed++;
    }
  }
  return `${billed} invoiced of ${due.length} due${debited ? `, ${debited} auto-debited` : ''}${failed ? `, ${failed} failed` : ''}`;
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
export async function runDealFollowUps(): Promise<string> {
  const today = todayStr();
  const due = await db.select({
    id: deals.id, title: deals.title, company: deals.company, stage: deals.stage,
    value: deals.value, accountId: deals.accountId, businessId: deals.businessId,
    createdBy: deals.createdBy, nextFollowUpAt: deals.nextFollowUpAt,
    followUpNote: deals.followUpNote,
  }).from(deals)
    .where(and(
      isNotNull(deals.nextFollowUpAt),
      lte(deals.nextFollowUpAt, today),
      inArray(deals.stage, ['lead', 'contacted', 'proposal']),
    ));
  if (!due.length) return 'nothing due';

  // One email per person, not one per deal. Five separate reminders at 7am is how
  // a useful nudge becomes something you filter to a folder.
  const byUser = new Map<number, typeof due>();
  for (const d of due) {
    if (!d.createdBy) continue;
    const list = byUser.get(d.createdBy) ?? [];
    list.push(d);
    byUser.set(d.createdBy, list);
  }

  let sent = 0;
  for (const [userId, list] of byUser) {
    const [u] = await db.select({ email: users.email, name: users.name }).from(users)
      .where(and(eq(users.id, userId), eq(users.isActive, true))).limit(1);
    if (!u) continue;

    list.sort((a, b) => (a.nextFollowUpAt ?? '').localeCompare(b.nextFollowUpAt ?? ''));
    const lines = list.map((d) => {
      const late = daysBetween(today, d.nextFollowUpAt!);
      const when = late === 0 ? 'today' : `${late} day${late === 1 ? '' : 's'} ago`;
      const who = d.company ? ` (${d.company})` : '';
      return `  - ${d.title}${who} - due ${when}${d.followUpNote ? `: ${d.followUpNote}` : ''}`;
    });
    const overdue = list.filter((d) => daysBetween(today, d.nextFollowUpAt!) > 0).length;

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

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

export async function runInvoiceReminders(): Promise<string> {
  const today = todayStr();
  const rows = await db.select().from(documents).where(and(
    eq(documents.type, 'invoice'),
    eq(documents.status, 'sent'),            // draft = not sent yet, paid/void = done
    isNotNull(documents.dueDate),
    isNotNull(documents.clientEmail),
  ));

  // Each invoice is chased on its own business's schedule, so cache the schedule
  // per business rather than re-reading it for every invoice.
  const bizCache = new Map<number, { enabled: boolean; offsets: number[]; suspendAfter: number | null; brand: string }>();
  async function scheduleFor(businessId: number | null) {
    if (businessId == null) return { enabled: true, offsets: DEFAULT_REMINDER_OFFSETS, suspendAfter: null, brand: 'Accounts' };
    const cached = bizCache.get(businessId);
    if (cached) return cached;
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
    if (!cfg.enabled) continue;
    if (doc.lastReminderOn === today) continue; // never twice in a day

    const overdueBy = -daysBetween(doc.dueDate!, today); // >0 means overdue
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
          ['Amount', `${doc.currency} ${doc.total}`] as [string, string],
          ['Was due', doc.dueDate!] as [string, string],
          ['Days overdue', String(overdueBy)] as [string, string],
        ],
        ...(payLink ? { button: { label: 'Pay now', url: payLink } } : {}),
        note: 'If you have already paid, please let us know so we can update our records.',
      };
      try {
        await sendBusinessMail({
          accountId: doc.accountId, businessId: doc.businessId, purpose: 'invoice',
          to: doc.clientEmail!, subject: `Action needed: invoice ${doc.number} overdue`,
          text: renderEmailText(emailBrand, content), html: renderEmail(emailBrand, content),
        });
        await db.update(documents).set({ lastReminderOn: today, suspendedAt: new Date() })
          .where(and(eq(documents.accountId, doc.accountId), eq(documents.id, doc.id)));
        suspended++;
      } catch { /* retry next run */ }
      continue;
    }

    // A normal reminder is due when today has reached one of the scheduled dates
    // (dueDate + offset) that we have not already passed. Using "<= today and later
    // than the last reminder" means a missed day is caught up rather than skipped.
    const scheduledDates = cfg.offsets.map((o) => addDaysStr(doc.dueDate!, o)).sort();
    const dueNow = scheduledDates.filter((d) => daysBetween(d, today) <= 0
      && (!doc.lastReminderOn || daysBetween(doc.lastReminderOn, d) > 0));
    if (dueNow.length === 0) continue;

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
        ['Amount', `${doc.currency} ${doc.total}`] as [string, string],
        [overdueBy > 0 ? 'Was due' : 'Due', doc.dueDate!] as [string, string],
      ],
      ...(payLink ? { button: { label: 'Pay now', url: payLink } } : {}),
      note: 'If it is already paid, please ignore this.',
    };

    try {
      await sendBusinessMail({
        accountId: doc.accountId, businessId: doc.businessId, purpose: 'invoice',
        to: doc.clientEmail!, subject,
        text: renderEmailText(emailBrand, content), html: renderEmail(emailBrand, content),
      });
      await db.update(documents).set({ lastReminderOn: today })
        .where(and(eq(documents.accountId, doc.accountId), eq(documents.id, doc.id)));
      sent++;
    } catch { /* try again on the next run */ }
  }
  return `${sent} chased, ${suspended} flagged, of ${rows.length} unpaid`;
}

/** dateStr + n days, as YYYY-MM-DD. */
function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const RUNNERS: Record<JobName, () => Promise<string>> = {
  'daily-digest': runDailyDigest,
  'bill-subscriptions': runSubscriptionBilling,
  'hosting-suspensions': runHostingSuspensions,
  'deal-follow-ups': runDealFollowUps,
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
