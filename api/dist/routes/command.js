import { z } from 'zod';
import { eq, gte, isNotNull, lt, lte, ne, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, boards, folders, deals, documents, payments, subscriptions, calendarEvents, } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { businessScope } from '../lib/access.js';
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
export async function commandRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/command-centre', async (req) => {
        const { accountId, userId } = authOf(req);
        const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
        const onlyBusiness = q.success ? q.data.businessId : undefined;
        const today = todayStr();
        const bizFilter = (col) => onlyBusiness ? eq(col, onlyBusiness) : undefined;
        // ---- Money owed ---------------------------------------------------------
        const overdueInvoices = await db.select({
            id: documents.id, number: documents.number, clientName: documents.clientName,
            total: documents.total, dueDate: documents.dueDate, suspendedAt: documents.suspendedAt,
            currency: documents.currency,
        }).from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.type, 'invoice'), eq(documents.status, 'sent'), isNotNull(documents.dueDate), lt(documents.dueDate, today), bizFilter(documents.businessId), await businessScope(req, documents.businessId)));
        // Net off payments and credits so we chase what is actually owed.
        const invIds = overdueInvoices.map((i) => i.id);
        const paidBy = new Map();
        const creditedBy = new Map();
        if (invIds.length) {
            const pays = await db.select({ documentId: payments.documentId, amount: sql `SUM(${payments.amount})` })
                .from(payments).where(tenantWhere(payments, accountId, inArray(payments.documentId, invIds)))
                .groupBy(payments.documentId);
            for (const p of pays)
                paidBy.set(p.documentId, Number(p.amount));
            const creds = await db.select({ src: documents.sourceDocumentId, amount: sql `SUM(${documents.total})` })
                .from(documents).where(tenantWhere(documents, accountId, eq(documents.type, 'credit_note'), inArray(documents.sourceDocumentId, invIds), ne(documents.status, 'void')))
                .groupBy(documents.sourceDocumentId);
            for (const c of creds)
                if (c.src != null)
                    creditedBy.set(c.src, Number(c.amount));
        }
        const owed = overdueInvoices
            .map((i) => ({
            ...i,
            outstanding: Math.round((Number(i.total) - (paidBy.get(i.id) ?? 0) - (creditedBy.get(i.id) ?? 0)) * 100) / 100,
            days: i.dueDate ? daysBetween(today, i.dueDate) : 0,
        }))
            .filter((i) => i.outstanding > 0.001);
        // ---- Work ---------------------------------------------------------------
        const openTasks = await db.select({
            id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, priority: tasks.priority,
            assignedTo: tasks.assignedTo, businessId: folders.businessId, folderName: folders.name,
        }).from(tasks)
            .leftJoin(boards, eq(boards.id, tasks.boardId))
            .leftJoin(folders, eq(folders.id, boards.folderId))
            .where(tenantWhere(tasks, accountId, eq(tasks.isArchived, false), eq(tasks.isCompleted, false), onlyBusiness ? eq(folders.businessId, onlyBusiness) : undefined, await businessScope(req, folders.businessId)));
        const mine = openTasks.filter((t) => t.assignedTo === userId || t.assignedTo == null);
        const overdueTasks = mine.filter((t) => t.dueDate && t.dueDate < today);
        const dueToday = mine.filter((t) => t.dueDate === today);
        // ---- Pipeline -----------------------------------------------------------
        const openDeals = await db.select({
            id: deals.id, title: deals.title, company: deals.company, value: deals.value,
            stage: deals.stage, updatedAt: deals.updatedAt,
        }).from(deals)
            .where(tenantWhere(deals, accountId, inArray(deals.stage, ['lead', 'contacted', 'proposal']), bizFilter(deals.businessId), await businessScope(req, deals.businessId)));
        // A deal nobody has touched in a fortnight is quietly dying.
        const STALE_DAYS = 14;
        const stale = openDeals
            .map((d) => ({ ...d, idle: d.updatedAt ? Math.floor((Date.now() - d.updatedAt.getTime()) / 86400000) : 0 }))
            .filter((d) => d.idle >= STALE_DAYS);
        // ---- Recurring ----------------------------------------------------------
        const dueSubs = await db.select({
            id: subscriptions.id, nextBillDate: subscriptions.nextBillDate,
        }).from(subscriptions)
            .where(tenantWhere(subscriptions, accountId, eq(subscriptions.status, 'active'), lte(subscriptions.nextBillDate, today), bizFilter(subscriptions.businessId), await businessScope(req, subscriptions.businessId)));
        // ---- Today's diary ------------------------------------------------------
        // Only what is still ahead: a meeting you have already had is not a to-do.
        const now = new Date();
        const meetings = await db.select({
            id: calendarEvents.id, title: calendarEvents.title, startAt: calendarEvents.startAt,
            allDay: calendarEvents.allDay, location: calendarEvents.location, clientName: folders.name,
        }).from(calendarEvents)
            .leftJoin(folders, eq(folders.id, calendarEvents.folderId))
            .where(tenantWhere(calendarEvents, accountId, gte(calendarEvents.startAt, now), lte(calendarEvents.startAt, new Date(`${today}T23:59:59.999Z`)), bizFilter(calendarEvents.businessId), await businessScope(req, calendarEvents.businessId)));
        // ---- The feed -----------------------------------------------------------
        // Worst first, and capped, because a list of seventy is the thing we are
        // replacing. Everything here is something a person can act on today.
        const feed = [];
        for (const i of owed) {
            feed.push({
                kind: i.suspendedAt ? 'invoice_suspended' : 'invoice_overdue',
                urgency: i.suspendedAt || i.days >= 14 ? 'critical' : 'high',
                title: `${i.clientName} owes ${i.currency} ${i.outstanding.toFixed(2)}`,
                detail: `${i.number}, ${i.days} day${i.days === 1 ? '' : 's'} overdue${i.suspendedAt ? ', flagged at risk' : ''}`,
                view: 'collections', amount: i.outstanding, days: i.days,
            });
        }
        for (const m of meetings.slice(0, 5)) {
            feed.push({
                kind: 'meeting_today', urgency: 'high',
                title: m.title,
                detail: [m.clientName, m.location].filter(Boolean).join(', '),
                at: m.allDay ? undefined : m.startAt.toISOString(),
                view: 'calendar',
            });
        }
        for (const t of overdueTasks.slice(0, 8)) {
            feed.push({
                kind: 'task_overdue', urgency: 'high',
                title: t.title,
                detail: `was due ${t.dueDate}${t.folderName ? `, ${t.folderName}` : ''}`,
                view: 'today', days: t.dueDate ? daysBetween(today, t.dueDate) : 0,
            });
        }
        for (const d of stale.slice(0, 5)) {
            feed.push({
                kind: 'deal_stale', urgency: 'normal',
                title: `${d.company || d.title} has gone quiet`,
                detail: `${d.stage}, no movement in ${d.idle} days, worth ${Number(d.value).toFixed(2)}`,
                view: 'pipeline', amount: Number(d.value), days: d.idle,
            });
        }
        for (const t of dueToday.slice(0, 8)) {
            feed.push({ kind: 'task_today', urgency: 'normal', title: t.title, detail: 'due today', view: 'today' });
        }
        if (dueSubs.length) {
            feed.push({
                kind: 'subscription_due', urgency: 'normal',
                title: `${dueSubs.length} subscription${dueSubs.length === 1 ? '' : 's'} ready to bill`,
                detail: 'Klippy raises these automatically on its next run',
                view: 'billing',
            });
        }
        const rank = { critical: 0, high: 1, normal: 2 };
        feed.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (b.amount ?? 0) - (a.amount ?? 0));
        // ---- The constraint -----------------------------------------------------
        // Four candidates, each scored on how badly it is binding right now. Only the
        // worst is reported: naming one problem is help, naming four is a list.
        const owedTotal = owed.reduce((s, i) => s + i.outstanding, 0);
        const pipelineValue = openDeals.reduce((s, d) => s + Number(d.value), 0);
        const candidates = [
            {
                key: 'cash',
                score: owedTotal > 0 ? Math.min(100, 40 + owed.length * 10 + (owed.some((i) => i.days >= 21) ? 25 : 0)) : 0,
                title: 'Getting paid',
                detail: `${owed.length} overdue invoice${owed.length === 1 ? '' : 's'} worth ${owedTotal.toFixed(2)} is money you have already earned.`,
                action: 'Chase the oldest one today.',
                view: 'collections',
            },
            {
                key: 'leads',
                score: openDeals.length === 0 ? 90 : openDeals.length < 3 ? 55 : 0,
                title: 'Not enough coming in',
                detail: openDeals.length === 0
                    ? 'There is nothing in the pipeline at all, so nothing is on its way to becoming work.'
                    : `Only ${openDeals.length} open deal${openDeals.length === 1 ? '' : 's'}, which is thin.`,
                action: 'Add the people you have been meaning to contact.',
                view: 'pipeline',
            },
            {
                key: 'conversion',
                score: stale.length >= 2 ? Math.min(80, 30 + stale.length * 10) : 0,
                title: 'Deals going quiet',
                detail: `${stale.length} deal${stale.length === 1 ? '' : 's'} with no movement in two weeks, worth ${stale.reduce((s, d) => s + Number(d.value), 0).toFixed(2)}.`,
                action: 'Follow up on the biggest one.',
                view: 'pipeline',
            },
            {
                key: 'capacity',
                score: overdueTasks.length >= 3 ? Math.min(85, 30 + overdueTasks.length * 6) : 0,
                title: 'Delivery is behind',
                detail: `${overdueTasks.length} pieces of work are past their date, so promises are slipping.`,
                action: 'Clear or re-date the oldest, and stop taking on more this week.',
                view: 'today',
            },
        ].filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
        const constraint = candidates[0]
            ? { ...candidates[0], alternatives: candidates.slice(1).map((c) => c.title) }
            : null;
        return {
            constraint,
            feed: feed.slice(0, 12),
            counts: {
                meetingsToday: meetings.length,
                overdueInvoices: owed.length,
                owed: Math.round(owedTotal * 100) / 100,
                overdueTasks: overdueTasks.length,
                dueToday: dueToday.length,
                openDeals: openDeals.length,
                pipelineValue: Math.round(pipelineValue * 100) / 100,
                staleDeals: stale.length,
            },
        };
    });
}
//# sourceMappingURL=command.js.map