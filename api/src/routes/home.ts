import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, gte, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  documents, payments, tasks, boards, folders, calendarEvents, deals, socialPosts, businesses,
} from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { accessibleBusinessIds } from '../lib/access.js';
import { balancesFor } from '../lib/balances.js';

/**
 * Home: the one "Needs you" list.
 *
 * Home used to be a matrix and three engine cards you had to read and interpret.
 * This answers one question instead: what do I have to do, in what order. Every
 * row is a real record (an invoice, a quote, a task, a meeting, a deal, a post),
 * grouped Overdue, Today, This week, and carries the one action that finishes it.
 *
 * Money is worked out with balancesFor(), the rule every money screen uses, and
 * kept per currency because Klippy never converts. The three figures on top are
 * built so nothing is counted twice: Coming in leaves out anything already late,
 * because that is already in Owed.
 */

type PerCur = Record<string, number>;
const round = (n: number) => Math.round(n * 100) / 100;
const add = (m: PerCur, cur: string, n: number) => { m[cur] = round((m[cur] ?? 0) + n); };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 27 Sep, the way a person says it, not 2026-09-27. */
const say = (day: string) => `${Number(day.slice(8, 10))} ${MON[Number(day.slice(5, 7)) - 1]}`;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

type Group = 'overdue' | 'today' | 'week';
interface Item {
  key: string;
  group: Group;
  kind: 'invoice-late' | 'invoice-due' | 'draft' | 'quote-accepted' | 'quote-expiring'
    | 'task' | 'event' | 'deal' | 'post';
  title: string;
  sub: string;
  businessId: number | null;
  folderId: number | null;
  clientName: string | null;
  amount?: number;
  currency?: string;
  /** Also the face value, when part has already been paid. */
  of?: number;
  docId?: number;
  docType?: string;
  docNumber?: string;
  taskId?: number;
  boardId?: number;
  eventId?: number;
  dealId?: number;
  postId?: number;
  /** A meeting's start, for the browser to write in local time. */
  at?: string;
  allDay?: boolean;
  /** Sort inside a group: smaller first. */
  rank: number;
}

export async function homeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/v1/home', async (req) => {
    const { accountId } = authOf(req);
    const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    const only = q.success ? q.data.businessId : undefined;
    const allowed = await accessibleBusinessIds(req);
    // A row with no business is visible to everyone in the account, as everywhere else.
    const inScope = (bid: number | null) =>
      (bid == null || allowed === null || allowed.has(bid)) && (only === undefined || bid == null || bid === only);

    const today = iso(new Date());
    const weekEnd = plusDays(today, 7);
    const monthStart = `${today.slice(0, 8)}01`;
    const items: Item[] = [];

    // ---- Documents -----------------------------------------------------------------
    const docs = (await db.select({
      id: documents.id, type: documents.type, number: documents.number, status: documents.status,
      clientName: documents.clientName, folderId: documents.folderId, businessId: documents.businessId,
      issueDate: documents.issueDate, dueDate: documents.dueDate, total: documents.total,
      currency: documents.currency, decision: documents.decision, lastReminderOn: documents.lastReminderOn,
      createdAt: documents.createdAt,
    }).from(documents)
      .where(tenantWhere(documents, accountId, ne(documents.status, 'void'), ne(documents.status, 'paid'))))
      .filter((d) => inScope(d.businessId));

    const unpaid = docs.filter((d) => d.type === 'invoice' && d.status === 'sent');
    const bal = await balancesFor(accountId, unpaid);
    const owed: PerCur = {};
    const overdue: PerCur = {};
    const comingIn: PerCur = {};
    const comingEnd = plusDays(today, 56);

    for (const d of unpaid) {
      const left = bal.get(d.id)?.outstanding ?? Number(d.total);
      if (left <= 0.001) continue;
      add(owed, d.currency, left);
      const base = {
        businessId: d.businessId, folderId: d.folderId, clientName: d.clientName,
        amount: round(left), currency: d.currency, of: left < Number(d.total) - 0.001 ? Number(d.total) : undefined,
        docId: d.id, docType: d.type, docNumber: d.number,
      };
      if (d.dueDate && d.dueDate < today) {
        add(overdue, d.currency, left);
        const n = daysBetween(d.dueDate, today);
        items.push({
          ...base, key: `inv-${d.id}`, group: 'overdue', kind: 'invoice-late',
          title: `${d.number} is ${n} ${n === 1 ? 'day' : 'days'} overdue`,
          sub: d.lastReminderOn ? `Chased ${say(d.lastReminderOn)}` : 'Not chased yet',
          rank: -n,
        });
      } else {
        if (d.dueDate && d.dueDate <= comingEnd) add(comingIn, d.currency, left);
        if (d.dueDate === today) {
          items.push({
            ...base, key: `inv-${d.id}`, group: 'today', kind: 'invoice-due',
            title: `${d.number} is due today`, sub: 'If it is in your bank, mark it paid', rank: 10,
          });
        }
      }
    }

    for (const d of docs) {
      if (d.status === 'draft' && d.type !== 'credit_note') {
        const age = daysBetween(iso(new Date(d.createdAt)), today);
        items.push({
          key: `draft-${d.id}`, group: 'today', kind: 'draft',
          title: `${d.number} is a draft nobody has seen`,
          sub: age > 0 ? `Made ${age} ${age === 1 ? 'day' : 'days'} ago. Nothing is owed until it goes out` : 'Made today. Nothing is owed until it goes out',
          businessId: d.businessId, folderId: d.folderId, clientName: d.clientName,
          amount: Number(d.total), currency: d.currency, docId: d.id, docType: d.type, docNumber: d.number,
          rank: 20 - age,
        });
      }
      // Accepted by the client (portal or the public link) but not turned into an
      // invoice yet: converting sets the quote to "accepted", so "sent" plus a yes
      // means nobody has billed it.
      if (d.type === 'quote' && d.status === 'sent' && d.decision === 'accepted') {
        items.push({
          key: `qa-${d.id}`, group: 'today', kind: 'quote-accepted',
          title: `${d.clientName} said yes to ${d.number}`, sub: 'It is not an invoice yet',
          businessId: d.businessId, folderId: d.folderId, clientName: d.clientName,
          amount: Number(d.total), currency: d.currency, docId: d.id, docType: d.type, docNumber: d.number,
          rank: 5,
        });
      }
      if (d.type === 'quote' && d.status === 'sent' && !d.decision && d.dueDate
        && d.dueDate >= today && d.dueDate <= plusDays(today, 3)) {
        items.push({
          key: `qe-${d.id}`, group: 'week', kind: 'quote-expiring',
          title: `${d.number} runs out ${d.dueDate === today ? 'today' : `on ${say(d.dueDate)}`}`,
          sub: 'No answer from them yet', businessId: d.businessId, folderId: d.folderId,
          clientName: d.clientName, amount: Number(d.total), currency: d.currency,
          docId: d.id, docType: d.type, docNumber: d.number, rank: daysBetween(today, d.dueDate),
        });
      }
    }

    // ---- Money in ------------------------------------------------------------------
    const pays = await db.select({
      amount: payments.amount, paidOn: payments.paidOn, method: payments.method,
      documentId: payments.documentId, pfPaymentId: payments.pfPaymentId,
    }).from(payments)
      .where(tenantWhere(payments, accountId, gte(payments.paidOn, monthStart)));
    const payDocIds = [...new Set(pays.map((p) => p.documentId))];
    const payDocs = payDocIds.length ? await db.select({
      id: documents.id, number: documents.number, clientName: documents.clientName,
      currency: documents.currency, businessId: documents.businessId, lastReminderOn: documents.lastReminderOn,
    }).from(documents).where(tenantWhere(documents, accountId, inArray(documents.id, payDocIds))) : [];
    const payDoc = new Map(payDocs.map((d) => [d.id, d]));
    const moneyIn: PerCur = {};
    const afterReminder: PerCur = {};
    const remindedDocs = new Set<number>();
    const cardSelf: PerCur = {};
    const byMethod: { method: string; currency: string; amount: number }[] = [];
    const cameInToday: { docId: number; number: string; clientName: string; amount: number; currency: string; method: string }[] = [];
    for (const p of pays) {
      const d = payDoc.get(p.documentId);
      if (!d || !inScope(d.businessId)) continue;
      const amt = Number(p.amount);
      add(moneyIn, d.currency, amt);
      const method = p.method || 'Other';
      const row = byMethod.find((m) => m.method === method && m.currency === d.currency);
      if (row) row.amount = round(row.amount + amt); else byMethod.push({ method, currency: d.currency, amount: round(amt) });
      // What Klippy did: money that arrived after a reminder went out (lastReminderOn
      // stops moving once an invoice is paid, so a reminder on or before the payment
      // date is the one that preceded it), and card payments that recorded themselves.
      if (d.lastReminderOn && d.lastReminderOn <= p.paidOn && amt > 0) {
        add(afterReminder, d.currency, amt);
        remindedDocs.add(d.id);
      }
      if (p.pfPaymentId && amt > 0) add(cardSelf, d.currency, amt);
      if (p.paidOn === today) {
        cameInToday.push({ docId: d.id, number: d.number, clientName: d.clientName, amount: round(amt), currency: d.currency, method });
      }
    }

    // Invoices the schedule raised on its own this month (a repeating invoice).
    const auto = (await db.select({ id: documents.id, businessId: documents.businessId }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.type, 'invoice'),
        isNotNull(documents.subscriptionId), gte(documents.issueDate, monthStart))))
      .filter((d) => inScope(d.businessId)).length;

    // ---- Tasks ---------------------------------------------------------------------
    const tree = await db.select({ id: folders.id, parentId: folders.parentId, businessId: folders.businessId, name: folders.name })
      .from(folders).where(tenantWhere(folders, accountId, isNull(folders.deletedAt)));
    const fById = new Map(tree.map((f) => [f.id, f]));
    const rootOf = (id: number) => {
      let cur = fById.get(id);
      for (let i = 0; i < 100 && cur?.parentId != null; i++) cur = fById.get(cur.parentId) ?? cur;
      return cur;
    };
    const boardRows = await db.select({ id: boards.id, name: boards.name, folderId: boards.folderId }).from(boards)
      .where(tenantWhere(boards, accountId, isNull(boards.deletedAt), eq(boards.isArchived, false)));
    const boardOf = new Map(boardRows.map((b) => [b.id, b]));
    const openTasks = await db.select({
      id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, boardId: tasks.boardId,
    }).from(tasks)
      .where(tenantWhere(tasks, accountId, eq(tasks.isCompleted, false), eq(tasks.isArchived, false),
        lte(tasks.dueDate, weekEnd)));
    for (const t of openTasks) {
      const b = boardOf.get(t.boardId);
      if (!b || !t.dueDate) continue;
      const root = rootOf(b.folderId);
      const bid = root?.businessId ?? null;
      if (!inScope(bid)) continue;
      const group: Group = t.dueDate < today ? 'overdue' : t.dueDate === today ? 'today' : 'week';
      const n = daysBetween(t.dueDate, today);
      items.push({
        key: `task-${t.id}`, group, kind: 'task', title: t.title,
        sub: [root?.name, b.name].filter(Boolean).join(', ') + (group === 'overdue' ? `. ${n} ${n === 1 ? 'day' : 'days'} late` : ''),
        businessId: bid, folderId: root?.id ?? null, clientName: null,
        taskId: t.id, boardId: t.boardId, rank: group === 'week' ? daysBetween(today, t.dueDate) : -n,
      });
    }

    // ---- Meetings ------------------------------------------------------------------
    const evs = await db.select({
      id: calendarEvents.id, title: calendarEvents.title, startAt: calendarEvents.startAt,
      allDay: calendarEvents.allDay, location: calendarEvents.location,
      businessId: calendarEvents.businessId, folderId: calendarEvents.folderId,
    }).from(calendarEvents)
      .where(tenantWhere(calendarEvents, accountId,
        gte(calendarEvents.startAt, new Date(`${today}T00:00:00Z`)),
        lte(calendarEvents.startAt, new Date(`${weekEnd}T23:59:59Z`))));
    for (const e of evs) {
      if (!inScope(e.businessId)) continue;
      const day = iso(e.startAt);
      // The time is written by the browser, in the person's own timezone; the
      // server only knows UTC and would put a 9am meeting at 7am.
      items.push({
        key: `ev-${e.id}`, group: day === today ? 'today' : 'week', kind: 'event', title: e.title,
        sub: e.location ?? '', at: e.startAt.toISOString(), allDay: e.allDay,
        businessId: e.businessId, folderId: e.folderId, clientName: null, eventId: e.id,
        rank: e.startAt.getTime() / 1e12,
      });
    }

    // ---- Deals with a follow-up due ------------------------------------------------
    const ds = await db.select({
      id: deals.id, title: deals.title, nextFollowUpAt: deals.nextFollowUpAt, followUpNote: deals.followUpNote,
      businessId: deals.businessId, company: deals.company,
    }).from(deals)
      .where(tenantWhere(deals, accountId, ne(deals.stage, 'won'), ne(deals.stage, 'lost'),
        lte(deals.nextFollowUpAt, weekEnd)));
    for (const d of ds) {
      if (!d.nextFollowUpAt || !inScope(d.businessId)) continue;
      const group: Group = d.nextFollowUpAt < today ? 'overdue' : d.nextFollowUpAt === today ? 'today' : 'week';
      items.push({
        key: `deal-${d.id}`, group, kind: 'deal', title: `Follow up: ${d.title}`,
        sub: d.followUpNote || (d.company ?? 'A job you are trying to win'),
        businessId: d.businessId, folderId: null, clientName: d.company, dealId: d.id,
        rank: daysBetween(today, d.nextFollowUpAt),
      });
    }

    // ---- Posts that need you -------------------------------------------------------
    const ps = await db.select({
      id: socialPosts.id, title: socialPosts.title, status: socialPosts.status,
      businessId: socialPosts.businessId, folderId: socialPosts.folderId,
    }).from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, inArray(socialPosts.status, ['failed', 'needs_manual', 'approved'])));
    for (const p of ps) {
      if (!inScope(p.businessId)) continue;
      items.push({
        key: `post-${p.id}`, group: 'today', kind: 'post', title: p.title,
        sub: p.status === 'failed' ? 'It did not go out. Fix it and try again'
          : p.status === 'needs_manual' ? 'Ready for you to post by hand'
            : 'Approved by the client, but not scheduled yet',
        businessId: p.businessId, folderId: p.folderId, clientName: null, postId: p.id,
        rank: p.status === 'failed' ? 0 : 1,
      });
    }

    const order: Record<Group, number> = { overdue: 0, today: 1, week: 2 };
    items.sort((a, b) => order[a.group] - order[b.group] || a.rank - b.rank || a.key.localeCompare(b.key));

    // Per-business counts for the Showing menu, counted by the same rule as the list.
    const bizRows = await db.select({ id: businesses.id }).from(businesses).where(tenantWhere(businesses, accountId));
    const perBusiness = bizRows
      .filter((b) => allowed === null || allowed.has(b.id))
      .map((b) => ({ id: b.id, count: items.filter((i) => i.businessId == null || i.businessId === b.id).length }));

    return {
      today,
      figures: { owed, overdue, comingIn, moneyIn, byMethod, cameInToday },
      didForYou: { afterReminder, afterReminderCount: remindedDocs.size, autoInvoices: auto, cardSelf },
      items,
      counts: {
        overdue: items.filter((i) => i.group === 'overdue').length,
        today: items.filter((i) => i.group === 'today').length,
        week: items.filter((i) => i.group === 'week').length,
      },
      perBusiness,
    };
  });
}

