import { z } from 'zod';
import { and, eq, gte, isNotNull, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { timeEntries, tasks, boards, folders, users, accounts, expenses, offerings } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export async function reportRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    /**
     * Time in a date range turned into money.
     * Work rolls up to the top-level folder (the client you would invoice), and
     * the hourly rate is inherited from the nearest ancestor that has one set.
     */
    app.get('/api/v1/reports/time', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({
            from: dateStr, to: dateStr,
            businessId: z.coerce.number().int().positive().optional(),
        }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) required.' });
        const onlyBusiness = q.data.businessId;
        const start = new Date(`${q.data.from}T00:00:00.000Z`);
        const end = new Date(`${q.data.to}T23:59:59.999Z`);
        const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        const currency = account?.currency ?? 'ZAR';
        // Every folder, so we can walk ancestors for rate inheritance and roll-up.
        const allFolders = await db.select({
            id: folders.id, parentId: folders.parentId, name: folders.name,
            hourlyRate: folders.hourlyRate, businessId: folders.businessId,
        }).from(folders).where(tenantWhere(folders, accountId));
        const byId = new Map(allFolders.map((f) => [f.id, f]));
        const rootOf = (folderId) => {
            let cur = byId.get(folderId);
            for (let i = 0; i < 100 && cur?.parentId != null; i++)
                cur = byId.get(cur.parentId) ?? cur;
            return cur;
        };
        const rateFor = (folderId) => {
            let cur = byId.get(folderId);
            for (let i = 0; i < 100 && cur; i++) {
                if (cur.hourlyRate != null)
                    return Number(cur.hourlyRate);
                if (cur.parentId == null)
                    break;
                cur = byId.get(cur.parentId);
            }
            return null;
        };
        const entries = await db.select({
            seconds: timeEntries.durationSeconds,
            userId: timeEntries.userId,
            userName: users.name,
            folderId: boards.folderId,
        }).from(timeEntries)
            .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
            .innerJoin(boards, eq(boards.id, tasks.boardId))
            .leftJoin(users, eq(users.id, timeEntries.userId))
            .where(tenantWhere(timeEntries, accountId, and(isNotNull(timeEntries.durationSeconds), gte(timeEntries.startTime, start), lte(timeEntries.startTime, end))));
        const perClient = new Map();
        const perPerson = new Map();
        let totalSeconds = 0;
        for (const e of entries) {
            const secs = Number(e.seconds ?? 0);
            if (!secs)
                continue;
            const root = rootOf(e.folderId);
            // When scoped to one business, only count work under that business.
            if (onlyBusiness !== undefined && root?.businessId !== onlyBusiness)
                continue;
            totalSeconds += secs;
            if (root) {
                const cur = perClient.get(root.id) ?? { name: root.name, seconds: 0, cost: 0 };
                cur.seconds += secs;
                perClient.set(root.id, cur);
            }
            const p = perPerson.get(e.userId) ?? { name: e.userName ?? 'Someone', seconds: 0 };
            p.seconds += secs;
            perPerson.set(e.userId, p);
        }
        // The cost side: expenses dated in the same range, scoped the same way by business.
        // Attribute each one (if tagged to a client) to that client's root folder, same
        // rollup rule as time, so per-client profit is possible - not just business totals.
        const expenseFilter = onlyBusiness !== undefined ? eq(expenses.businessId, onlyBusiness) : undefined;
        const expenseRows = await db.select({ amount: expenses.amount, folderId: expenses.folderId }).from(expenses)
            .where(tenantWhere(expenses, accountId, and(expenseFilter, gte(expenses.incurredOn, q.data.from), lte(expenses.incurredOn, q.data.to))));
        const expenseTotal = Math.round(expenseRows.reduce((s, e) => s + Number(e.amount), 0) * 100) / 100;
        for (const e of expenseRows) {
            if (e.folderId == null)
                continue; // general overhead, not attributed to a client
            const root = rootOf(e.folderId);
            if (!root || (onlyBusiness !== undefined && root.businessId !== onlyBusiness))
                continue;
            const cur = perClient.get(root.id) ?? { name: root.name, seconds: 0, cost: 0 };
            cur.cost += Number(e.amount);
            perClient.set(root.id, cur);
        }
        const clients = [...perClient.entries()].map(([folderId, v]) => {
            const rate = rateFor(folderId);
            const hours = v.seconds / 3600;
            const amount = rate == null ? null : Math.round(hours * rate * 100) / 100;
            const cost = Math.round(v.cost * 100) / 100;
            return {
                folderId, name: v.name, seconds: v.seconds,
                hours: Math.round(hours * 100) / 100,
                rate, amount, cost,
                profit: amount == null ? null : Math.round((amount - cost) * 100) / 100,
            };
        }).sort((a, b) => b.seconds - a.seconds);
        const people = [...perPerson.entries()].map(([userId, v]) => ({
            userId, name: v.name, seconds: v.seconds,
            hours: Math.round((v.seconds / 3600) * 100) / 100,
        })).sort((a, b) => b.seconds - a.seconds);
        const billable = clients.reduce((sum, c) => sum + (c.amount ?? 0), 0);
        // MRR is a snapshot, not date-ranged: sum of active recurring offerings right now.
        const offeringFilter = onlyBusiness !== undefined ? eq(offerings.businessId, onlyBusiness) : undefined;
        const offeringRows = await db.select({ price: offerings.price, recurring: offerings.recurring, active: offerings.active })
            .from(offerings).where(tenantWhere(offerings, accountId, offeringFilter));
        const mrr = Math.round(offeringRows.filter((o) => o.recurring && o.active)
            .reduce((s, o) => s + Number(o.price), 0) * 100) / 100;
        return {
            currency,
            from: q.data.from,
            to: q.data.to,
            clients,
            people,
            totals: {
                seconds: totalSeconds,
                hours: Math.round((totalSeconds / 3600) * 100) / 100,
                amount: Math.round(billable * 100) / 100,
                unratedClients: clients.filter((c) => c.rate == null).length,
                expenses: expenseTotal,
                profit: Math.round((billable - expenseTotal) * 100) / 100,
                mrr,
            },
        };
    });
    /**
     * Estimate vs actual. The payoff of time blocking: every card carries what you
     * thought it would take, and the timers already recorded what it really took, so
     * we can show the gap and let future estimates get less wrong.
     *
     * Only cards with BOTH an estimate and tracked time are compared, since a card
     * with one and not the other says nothing about accuracy.
     */
    app.get('/api/v1/reports/estimates', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({
            from: dateStr, to: dateStr,
            businessId: z.coerce.number().int().positive().optional(),
        }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) required.' });
        const onlyBusiness = q.data.businessId;
        const start = new Date(`${q.data.from}T00:00:00.000Z`);
        const end = new Date(`${q.data.to}T23:59:59.999Z`);
        // Actual tracked seconds per task in the range.
        const actuals = await db.select({
            taskId: timeEntries.taskId,
            seconds: sql `SUM(${timeEntries.durationSeconds})`,
        }).from(timeEntries)
            .where(tenantWhere(timeEntries, accountId, and(isNotNull(timeEntries.durationSeconds), gte(timeEntries.startTime, start), lte(timeEntries.startTime, end))))
            .groupBy(timeEntries.taskId);
        if (actuals.length === 0) {
            return { from: q.data.from, to: q.data.to, tasks: [], totals: { compared: 0, estimateMinutes: 0, actualMinutes: 0, accuracyPct: null } };
        }
        const ids = actuals.map((a) => a.taskId);
        const rows = await db.select({
            id: tasks.id, title: tasks.title, estimateMinutes: tasks.estimateMinutes,
            isCompleted: tasks.isCompleted, folderName: folders.name, businessId: folders.businessId,
        }).from(tasks)
            .leftJoin(boards, eq(boards.id, tasks.boardId))
            .leftJoin(folders, eq(folders.id, boards.folderId))
            .where(tenantWhere(tasks, accountId, and(inArray(tasks.id, ids), isNotNull(tasks.estimateMinutes))));
        const actualBy = new Map(actuals.map((a) => [a.taskId, Number(a.seconds ?? 0)]));
        const compared = rows
            .filter((t) => onlyBusiness === undefined || t.businessId === onlyBusiness)
            .map((t) => {
            const estimate = Number(t.estimateMinutes ?? 0);
            const actual = Math.round((actualBy.get(t.id) ?? 0) / 60);
            return {
                id: t.id, title: t.title, folderName: t.folderName, isCompleted: t.isCompleted,
                estimateMinutes: estimate, actualMinutes: actual,
                diffMinutes: actual - estimate,
                // Positive means it took longer than planned.
                overPct: estimate > 0 ? Math.round(((actual - estimate) / estimate) * 100) : null,
            };
        })
            .sort((a, b) => Math.abs(b.diffMinutes) - Math.abs(a.diffMinutes));
        const estimateTotal = compared.reduce((s, t) => s + t.estimateMinutes, 0);
        const actualTotal = compared.reduce((s, t) => s + t.actualMinutes, 0);
        return {
            from: q.data.from,
            to: q.data.to,
            tasks: compared.slice(0, 25),
            totals: {
                compared: compared.length,
                estimateMinutes: estimateTotal,
                actualMinutes: actualTotal,
                // How far off the estimates were overall. 0 = spot on, +25 = a quarter over.
                accuracyPct: estimateTotal > 0
                    ? Math.round(((actualTotal - estimateTotal) / estimateTotal) * 100) : null,
            },
        };
    });
}
//# sourceMappingURL=reports.js.map