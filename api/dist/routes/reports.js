import { z } from 'zod';
import { and, eq, gte, isNotNull, lte, ne, inArray, sql } from 'drizzle-orm';
import { DEFAULT_CURRENCY, roundMoney } from '../lib/currency.js';
import { mrrByCurrency, chargeFor } from '../lib/mrr.js';
import { addMonths, anchorDayOf, addDays } from '../lib/billing.js';
import { balancesFor } from '../lib/balances.js';
import { db } from '../db/client.js';
import { timeEntries, tasks, boards, folders, users, accounts, businesses, expenses, offerings, subscriptions, documents, payments, sales } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { accessibleBusinessIds, businessScope } from '../lib/access.js';
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
        // A member's report never sums a business they cannot access.
        const allowed = await accessibleBusinessIds(req);
        const canBiz = (bid) => allowed === null || bid == null || allowed.has(bid);
        const start = new Date(`${q.data.from}T00:00:00.000Z`);
        const end = new Date(`${q.data.to}T23:59:59.999Z`);
        const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        const workspaceCurrency = account?.currency || DEFAULT_CURRENCY;
        // Money recorded against a business is denominated in that business's currency:
        // an expense, an hourly rate and an offering price all belong to one business,
        // and that is what decides what the number means. Klippy never converts, so a
        // workspace running a rand company and a dollar company gets a line per
        // currency instead of one meaningless sum.
        const bizRows = await db.select({ id: businesses.id, currency: businesses.currency })
            .from(businesses).where(tenantWhere(businesses, accountId));
        const currencyOfBusiness = new Map(bizRows.map((b) => [b.id, b.currency || workspaceCurrency]));
        const curOf = (businessId) => (businessId != null ? currencyOfBusiness.get(businessId) : null) || workspaceCurrency;
        const scopeCurrency = onlyBusiness !== undefined ? curOf(onlyBusiness) : workspaceCurrency;
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
            if (!canBiz(root?.businessId ?? null))
                continue;
            // When scoped to one business, only count work under that business.
            if (onlyBusiness !== undefined && root?.businessId !== onlyBusiness)
                continue;
            totalSeconds += secs;
            if (root) {
                const cur = perClient.get(root.id)
                    ?? { name: root.name, seconds: 0, cost: 0, currency: curOf(root.businessId) };
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
        const expenseRows = await db.select({
            amount: expenses.amount, folderId: expenses.folderId, businessId: expenses.businessId,
        }).from(expenses)
            .where(tenantWhere(expenses, accountId, and(expenseFilter, await businessScope(req, expenses.businessId), gte(expenses.incurredOn, q.data.from), lte(expenses.incurredOn, q.data.to))));
        const expenseTotal = Math.round(expenseRows.reduce((s, e) => s + Number(e.amount), 0) * 100) / 100;
        for (const e of expenseRows) {
            if (e.folderId == null)
                continue; // general overhead, not attributed to a client
            const root = rootOf(e.folderId);
            if (!root || (onlyBusiness !== undefined && root.businessId !== onlyBusiness))
                continue;
            const cur = perClient.get(root.id)
                ?? { name: root.name, seconds: 0, cost: 0, currency: curOf(root.businessId) };
            cur.cost += Number(e.amount);
            perClient.set(root.id, cur);
        }
        const clients = [...perClient.entries()].map(([folderId, v]) => {
            const rate = rateFor(folderId);
            const hours = v.seconds / 3600;
            const amount = rate == null ? null : Math.round(hours * rate * 100) / 100;
            const cost = Math.round(v.cost * 100) / 100;
            return {
                folderId, name: v.name, seconds: v.seconds, currency: v.currency,
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
        // MRR is a snapshot, not date-ranged: what active subscriptions bill per month
        // right now. It used to sum the offerings catalogue, which measured the price
        // list rather than the business.
        const mrrRows = await mrrByCurrency(accountId, [
            onlyBusiness !== undefined ? eq(subscriptions.businessId, onlyBusiness) : undefined,
            await businessScope(req, subscriptions.businessId),
        ]);
        const mrrOf = new Map(mrrRows.map((m) => [m.currency, m.mrr]));
        const mrr = mrrRows.reduce((s, m) => s + m.mrr, 0);
        // The same figures split by currency. `mixed` is what the UI keys off: with one
        // currency the flat totals below are exactly right and simpler to read, and with
        // several they are the sum of unlike things and must not be shown.
        const bucket = new Map();
        const into = (cur) => {
            let b = bucket.get(cur);
            if (!b) {
                b = { billable: 0, expenses: 0, mrr: 0 };
                bucket.set(cur, b);
            }
            return b;
        };
        for (const c of clients)
            if (c.amount != null)
                into(c.currency).billable += c.amount;
        for (const e of expenseRows)
            into(curOf(e.businessId)).expenses += Number(e.amount);
        for (const m of mrrRows)
            into(m.currency).mrr += m.mrr;
        const round2 = (n) => Math.round(n * 100) / 100;
        const byCurrency = [...bucket].map(([cur, b]) => ({
            currency: cur,
            billable: round2(b.billable),
            expenses: round2(b.expenses),
            profit: round2(b.billable - b.expenses),
            mrr: round2(b.mrr),
        })).sort((a, b) => b.billable - a.billable);
        // The headline currency has to be the one the flat totals are actually in, not
        // the workspace default. A workspace-wide report over a single dollar business
        // was labelling real dollars as rand: one bucket, so `mixed` was false and the
        // UI drew the simple tiles, with the wrong currency on them.
        const currency = byCurrency.length === 1 ? byCurrency[0].currency : scopeCurrency;
        // The flat `mrr` below is only ever read when there is one currency, so it
        // reports that one rather than a sum across currencies that means nothing.
        const flatMrr = byCurrency.length > 1 ? (mrrOf.get(currency) ?? 0) : mrr;
        return {
            currency,
            byCurrency,
            mixed: byCurrency.length > 1,
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
                mrr: flatMrr,
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
        // A member's report never sums a business they cannot access.
        const allowed = await accessibleBusinessIds(req);
        const canBiz = (bid) => allowed === null || bid == null || allowed.has(bid);
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
            .filter((t) => canBiz(t.businessId) && (onlyBusiness === undefined || t.businessId === onlyBusiness))
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
    /**
     * A financial CSV export for a bookkeeper, so the numbers can leave the app at
     * year-end and each VAT cycle. `kind` picks the table; a date range bounds it.
     * The data always existed; it just had no way out.
     */
    app.get('/api/v1/reports/export', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({
            kind: z.enum(['invoices', 'payments', 'expenses']),
            from: dateStr, to: dateStr,
        }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'kind, from and to (YYYY-MM-DD) are required.' });
        const { kind, from, to } = q.data;
        const esc = (v) => {
            const str = v == null ? '' : String(v);
            // Quote anything with a comma, quote or newline; double internal quotes. This
            // is the whole of CSV correctness and the usual place exports get it wrong.
            return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
        };
        const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
        let csv = '';
        if (kind === 'invoices') {
            const rows = await db.select({
                number: documents.number, type: documents.type, issueDate: documents.issueDate,
                dueDate: documents.dueDate, client: documents.clientName, vat: documents.clientVatNumber,
                currency: documents.currency, subtotal: documents.subtotal, tax: documents.taxAmount,
                total: documents.total, status: documents.status,
            }).from(documents)
                .where(tenantWhere(documents, accountId, await businessScope(req, documents.businessId), inArray(documents.type, ['invoice', 'credit_note']), gte(documents.issueDate, from), lte(documents.issueDate, to)));
            csv = toCsv(['Number', 'Type', 'Issue date', 'Due date', 'Client', 'Client VAT', 'Currency', 'Subtotal', 'Tax', 'Total', 'Status'], rows.map((r) => [r.number, r.type, r.issueDate, r.dueDate, r.client, r.vat, r.currency, r.subtotal, r.tax, r.total, r.status]));
        }
        else if (kind === 'payments') {
            const rows = await db.select({
                paidOn: payments.paidOn, amount: payments.amount, method: payments.method,
                number: documents.number, client: documents.clientName, currency: documents.currency,
            }).from(payments).innerJoin(documents, eq(documents.id, payments.documentId))
                .where(and(eq(payments.accountId, accountId), await businessScope(req, documents.businessId), gte(payments.paidOn, from), lte(payments.paidOn, to)));
            csv = toCsv(['Paid on', 'Amount', 'Method', 'Invoice', 'Client', 'Currency'], rows.map((r) => [r.paidOn, r.amount, r.method, r.number, r.client, r.currency]));
        }
        else {
            const rows = await db.select({
                incurredOn: expenses.incurredOn, description: expenses.description,
                category: expenses.category, amount: expenses.amount,
            }).from(expenses)
                .where(and(eq(expenses.accountId, accountId), await businessScope(req, expenses.businessId), gte(expenses.incurredOn, from), lte(expenses.incurredOn, to)));
            csv = toCsv(['Date', 'Description', 'Category', 'Amount'], rows.map((r) => [r.incurredOn, r.description, r.category, r.amount]));
        }
        reply.header('Content-Type', 'text/csv; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="klippy-${kind}-${from}-to-${to}.csv"`);
        return reply.send(csv);
    });
    /**
     * VAT summary for a period: output VAT (on invoices raised) and input VAT (on
     * expenses that recorded a VAT amount), grouped by currency. A VAT-registered
     * business needs both sides to file; the app held valid tax invoices but could
     * compute neither, forcing a parallel spreadsheet every two months.
     */
    app.get('/api/v1/reports/vat', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({ from: dateStr, to: dateStr }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) required.' });
        const { from, to } = q.data;
        const invoices = await db.select({
            currency: documents.currency, type: documents.type, tax: documents.taxAmount, total: documents.total,
        }).from(documents)
            .where(tenantWhere(documents, accountId, await businessScope(req, documents.businessId), inArray(documents.type, ['invoice', 'credit_note']), 
        // Only ISSUED, non-void documents belong in a VAT return. Without these two
        // the report counted drafts (an invoice still being written, never sent to
        // anyone) and voids, and because credit notes carry a negative sign it cut
        // both ways: a voided invoice overstated the VAT owed, a voided credit note
        // understated it. This is the figure a SARS return is filed from.
        //
        // Two `ne` rather than inArray(['sent','paid']): the status route also
        // accepts 'accepted', and an accepted invoice has been issued. Credit notes
        // are always inserted as 'sent' (documents.ts), so excluding drafts cannot
        // silently drop the credit side of the return.
        ne(documents.status, 'void'), ne(documents.status, 'draft'), gte(documents.issueDate, from), lte(documents.issueDate, to)));
        const exps = await db.select({ amount: expenses.amount, vat: expenses.vatAmount })
            .from(expenses)
            .where(and(eq(expenses.accountId, accountId), await businessScope(req, expenses.businessId), gte(expenses.incurredOn, from), lte(expenses.incurredOn, to)));
        /**
         * Counter takings belong in the return too.
         *
         * A shop's card machine money never becomes an invoice, so a VAT return built
         * only from documents would declare the agency half of the business and silently
         * omit the retail half. The tax on a sale was worked out when it was recorded
         * (backed out of the gross, since money received is VAT-inclusive), so it is read
         * rather than recomputed here.
         */
        const salesRows = await db.select({ currency: sales.currency, tax: sales.taxAmount, gross: sales.gross })
            .from(sales)
            .where(tenantWhere(sales, accountId, await businessScope(req, sales.businessId), gte(sales.occurredAt, new Date(`${from}T00:00:00.000Z`)), lte(sales.occurredAt, new Date(`${to}T23:59:59.999Z`))));
        const round = (n) => Math.round(n * 100) / 100;
        const byCur = new Map();
        for (const r of salesRows) {
            const b = byCur.get(r.currency) ?? { outputVat: 0, sales: 0 };
            b.outputVat += Number(r.tax);
            b.sales += Number(r.gross);
            byCur.set(r.currency, b);
        }
        for (const r of invoices) {
            const sign = r.type === 'credit_note' ? -1 : 1;
            const b = byCur.get(r.currency) ?? { outputVat: 0, sales: 0 };
            b.outputVat += sign * Number(r.tax);
            b.sales += sign * Number(r.total);
            byCur.set(r.currency, b);
        }
        // Input VAT is not split by currency (expenses have no currency column yet); it
        // is reported against the workspace currency, which is where expenses are kept.
        const [acc] = await db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
        const wsCur = acc?.currency || DEFAULT_CURRENCY;
        const inputVat = round(exps.reduce((s, e) => s + Number(e.vat ?? 0), 0));
        const output = [...byCur].map(([currency, b]) => ({
            currency, sales: round(b.sales), outputVat: round(b.outputVat),
        })).sort((a, b) => b.outputVat - a.outputVat);
        const wsOutput = output.find((o) => o.currency === wsCur)?.outputVat ?? 0;
        return {
            from, to, currency: wsCur,
            output,
            inputVat,
            // Net is only meaningful within one currency; computed for the workspace
            // currency (output there minus input VAT, which is in the workspace currency).
            netPayable: round(wsOutput - inputVat),
        };
    });
    /**
     * The next eight weeks of money coming in, per currency.
     *
     * Two sources, both things the app already knows and previously kept apart:
     * invoices that are out and unpaid, bucketed by DUE date, and active
     * subscriptions projected forward at their real cadence (monthly, quarterly,
     * annual) using the same anchored month arithmetic the billing cron uses, so the
     * forecast and the invoices it turns into always agree. What is already overdue
     * sits in its own bucket rather than pretending it will arrive this week.
     *
     * This is a forecast of what SHOULD arrive, not a promise. Klippy never converts
     * currency, so a workspace billing in two currencies gets two forecasts.
     */
    app.get('/api/v1/reports/cashflow', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'Bad query.' });
        const onlyBusiness = q.data.businessId;
        const today = new Date().toISOString().slice(0, 10);
        const WEEKS = 8;
        const horizon = addDays(today, WEEKS * 7 - 1);
        const [acc] = await db.select({ currency: accounts.currency }).from(accounts)
            .where(eq(accounts.id, accountId)).limit(1);
        const workspace = acc?.currency || DEFAULT_CURRENCY;
        const bizRows = await db.select({ id: businesses.id, currency: businesses.currency })
            .from(businesses).where(tenantWhere(businesses, accountId));
        const currencyOfBiz = new Map(bizRows.map((b) => [b.id, b.currency || workspace]));
        const curOf = (bid) => (bid != null ? currencyOfBiz.get(bid) : null) || workspace;
        const invRows = await db.select({
            id: documents.id, total: documents.total, dueDate: documents.dueDate,
            currency: documents.currency, businessId: documents.businessId,
        }).from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.type, 'invoice'), eq(documents.status, 'sent'), isNotNull(documents.dueDate), onlyBusiness !== undefined ? eq(documents.businessId, onlyBusiness) : undefined, await businessScope(req, documents.businessId)));
        const balances = await balancesFor(accountId, invRows);
        const lanes = new Map();
        const laneOf = (cur) => {
            let l = lanes.get(cur);
            if (!l) {
                l = {
                    overdue: 0, overdueCount: 0, later: 0,
                    buckets: Array.from({ length: WEEKS }, (_, i) => ({
                        start: addDays(today, i * 7), end: addDays(today, i * 7 + 6), invoices: 0, subscriptions: 0,
                    })),
                };
                lanes.set(cur, l);
            }
            return l;
        };
        const weekIndex = (date) => Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / (7 * 86_400_000));
        for (const inv of invRows) {
            const owed = balances.get(inv.id)?.outstanding ?? Number(inv.total);
            if (owed <= 0.001)
                continue;
            const lane = laneOf(inv.currency);
            const due = inv.dueDate;
            if (due < today) {
                lane.overdue += owed;
                lane.overdueCount += 1;
            }
            else if (due > horizon)
                lane.later += owed;
            else
                lane.buckets[Math.min(WEEKS - 1, weekIndex(due))].invoices += owed;
        }
        const subRows = await db.select({
            price: subscriptions.price, listPrice: offerings.price,
            intervalMonths: subscriptions.intervalMonths, startedOn: subscriptions.startedOn,
            nextBillDate: subscriptions.nextBillDate, businessId: subscriptions.businessId,
        }).from(subscriptions)
            .innerJoin(offerings, eq(offerings.id, subscriptions.offeringId))
            .where(tenantWhere(subscriptions, accountId, eq(subscriptions.status, 'active'), onlyBusiness !== undefined ? eq(subscriptions.businessId, onlyBusiness) : undefined, await businessScope(req, subscriptions.businessId)));
        for (const s of subRows) {
            const amount = chargeFor(s, { price: s.listPrice });
            if (!Number.isFinite(amount) || amount <= 0)
                continue;
            const lane = laneOf(curOf(s.businessId));
            const anchor = anchorDayOf(s.startedOn);
            // A next-bill date the cron has not reached yet still bills, so count it now
            // rather than dropping it into the past.
            let d = s.nextBillDate < today ? today : s.nextBillDate;
            for (let i = 0; i < 24 && d <= horizon; i++) {
                lane.buckets[Math.min(WEEKS - 1, Math.max(0, weekIndex(d)))].subscriptions += amount;
                d = addMonths(d, s.intervalMonths, anchor);
            }
        }
        const currencies = [...lanes].map(([currency, l]) => {
            const buckets = l.buckets.map((b) => ({
                ...b,
                invoices: roundMoney(b.invoices, currency),
                subscriptions: roundMoney(b.subscriptions, currency),
                total: roundMoney(b.invoices + b.subscriptions, currency),
            }));
            const expected = roundMoney(l.overdue + buckets.reduce((s2, b) => s2 + b.total, 0), currency);
            return {
                currency,
                overdue: roundMoney(l.overdue, currency),
                overdueCount: l.overdueCount,
                later: roundMoney(l.later, currency),
                buckets,
                expected,
            };
        }).sort((a, b) => b.expected - a.expected);
        return { start: today, weeks: WEEKS, currencies };
    });
    /**
     * Work done but never invoiced, and retainers against their monthly allowance.
     *
     * Unbilled: every finished time entry with no billedDocumentId, rolled up to
     * the client and priced at the inherited hourly rate. This number only became
     * possible when invoices raised from time started stamping the entries they
     * covered; before that "did we ever bill those hours?" was archaeology.
     *
     * Retainers: clients with a monthly hours budget get this month's tracked
     * hours next to it, so "we are over on this client" is a fact, not a feeling.
     */
    app.get('/api/v1/reports/unbilled', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'Bad query.' });
        const onlyBusiness = q.data.businessId;
        const allowed = await accessibleBusinessIds(req);
        const canBiz = (bid) => allowed === null || bid == null || allowed.has(bid);
        const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        const workspaceCurrency = account?.currency || DEFAULT_CURRENCY;
        const bizRows = await db.select({ id: businesses.id, currency: businesses.currency })
            .from(businesses).where(tenantWhere(businesses, accountId));
        const curOf = (bid) => (bid != null ? bizRows.find((b) => b.id === bid)?.currency : null) || workspaceCurrency;
        const allFolders = await db.select({
            id: folders.id, parentId: folders.parentId, name: folders.name,
            hourlyRate: folders.hourlyRate, businessId: folders.businessId,
            monthlyHoursBudget: folders.monthlyHoursBudget, deletedAt: folders.deletedAt,
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
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const entries = await db.select({
            seconds: timeEntries.durationSeconds,
            startTime: timeEntries.startTime,
            billed: timeEntries.billedDocumentId,
            folderId: boards.folderId,
        }).from(timeEntries)
            .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
            .innerJoin(boards, eq(boards.id, tasks.boardId))
            .where(tenantWhere(timeEntries, accountId, isNotNull(timeEntries.durationSeconds)));
        const perClient = new Map();
        for (const e of entries) {
            const root = rootOf(e.folderId);
            if (!root || root.deletedAt)
                continue;
            if (!canBiz(root.businessId ?? null))
                continue;
            if (onlyBusiness !== undefined && root.businessId !== onlyBusiness)
                continue;
            let c = perClient.get(root.id);
            if (!c) {
                c = {
                    name: root.name, currency: curOf(root.businessId), rate: rateFor(root.id),
                    budget: root.monthlyHoursBudget != null ? Number(root.monthlyHoursBudget) : null,
                    unbilledSeconds: 0, monthSeconds: 0,
                };
                perClient.set(root.id, c);
            }
            const secs = Number(e.seconds ?? 0);
            if (e.billed == null)
                c.unbilledSeconds += secs;
            if (e.startTime >= monthStart)
                c.monthSeconds += secs;
        }
        // Budgeted clients with no time at all this month still belong on the list.
        for (const f of allFolders) {
            if (f.parentId != null || f.monthlyHoursBudget == null || f.deletedAt)
                continue;
            if (!canBiz(f.businessId ?? null))
                continue;
            if (onlyBusiness !== undefined && f.businessId !== onlyBusiness)
                continue;
            if (!perClient.has(f.id)) {
                perClient.set(f.id, {
                    name: f.name, currency: curOf(f.businessId), rate: rateFor(f.id),
                    budget: Number(f.monthlyHoursBudget), unbilledSeconds: 0, monthSeconds: 0,
                });
            }
        }
        const round2b = (n) => Math.round(n * 100) / 100;
        const clients = [...perClient.entries()].map(([folderId, c]) => {
            const unbilledHours = round2b(c.unbilledSeconds / 3600);
            const monthHours = round2b(c.monthSeconds / 3600);
            return {
                folderId, name: c.name, currency: c.currency, rate: c.rate,
                unbilledHours,
                unbilledAmount: c.rate == null ? null : round2b(unbilledHours * c.rate),
                monthHours,
                budgetHours: c.budget,
                overBudget: c.budget != null && monthHours > c.budget,
            };
        }).filter((c) => c.unbilledHours > 0 || c.budgetHours != null)
            .sort((a, b) => (b.unbilledAmount ?? 0) - (a.unbilledAmount ?? 0) || b.unbilledHours - a.unbilledHours);
        return { clients };
    });
}
//# sourceMappingURL=reports.js.map