import { z } from 'zod';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, payments } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, canSeeBusiness } from '../lib/access.js';
import { balancesFor, CHASE_MIN } from '../lib/balances.js';
import { settleIfCovered } from '../lib/settle.js';
import { money } from '../lib/money.js';
import { formatMoney } from '../lib/currency.js';
import { addDays } from '../lib/billing.js';
import { IMPORTED_SEQ_BASE } from '../lib/numbering.js';
import { readStatement, suggestMatches } from '../lib/bankStatement.js';
/**
 * Match a bank statement to open invoices, then record the ones a person ticks.
 *
 * Preview reads and suggests and writes nothing. Apply records each ticked match as
 * an EFT payment through the same rules as pressing Paid: invoices only, never a
 * cancelled one, never more than is owed, settled when covered. Running the same
 * statement twice records nothing the second time.
 */
export async function bankStatementRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    /** Open invoices in scope, with what is still owed on each. */
    async function openInvoices(req, accountId, businessId) {
        const rows = await db.select({
            id: documents.id, number: documents.number, clientName: documents.clientName, total: documents.total,
            currency: documents.currency, seq: documents.seq, businessId: documents.businessId, dueDate: documents.dueDate,
        }).from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.type, 'invoice'), eq(documents.status, 'sent'), businessId ? eq(documents.businessId, businessId) : undefined, await businessScope(req, documents.businessId)));
        const bal = await balancesFor(accountId, rows);
        return rows
            .map((r) => ({
            id: r.id, number: r.number, clientName: r.clientName, currency: r.currency, dueDate: r.dueDate,
            outstanding: Math.round((bal.get(r.id)?.outstanding ?? Number(r.total)) * 100) / 100,
            imported: r.seq >= IMPORTED_SEQ_BASE,
        }))
            .filter((r) => r.outstanding >= CHASE_MIN)
            .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.number.localeCompare(b.number));
    }
    app.post('/api/v1/bank-statement/preview', { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
        const { accountId } = authOf(req);
        const parsed = z.object({
            csv: z.string().min(1).max(3_000_000),
            businessId: z.number().int().positive().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Choose a CSV file exported from your bank.' });
        if (parsed.data.businessId && !(await canSeeBusiness(req, parsed.data.businessId))) {
            return reply.code(403).send({ error: 'You do not have access to that business.' });
        }
        let statement;
        try {
            statement = readStatement(parsed.data.csv);
        }
        catch (e) {
            return reply.code(400).send({ error: e instanceof Error ? e.message : 'That file could not be read.' });
        }
        if (statement.rows.length > 2000)
            return reply.code(400).send({ error: 'That statement has more than 2000 deposits. Export a shorter period.' });
        const open = await openInvoices(req, accountId, parsed.data.businessId);
        const suggestions = suggestMatches(statement.rows, open);
        const byLine = new Map(suggestions.map((s) => [s.line, s]));
        // Money that looks already recorded: a payment of the same amount within three
        // days of the deposit. Flagged and left unticked, never hidden, because two
        // clients can pay the same amount in the same week.
        const dates = statement.rows.map((r) => r.date).sort();
        const recorded = dates.length ? await db.select({
            amount: payments.amount, paidOn: payments.paidOn, number: documents.number,
        }).from(payments)
            .innerJoin(documents, and(eq(documents.id, payments.documentId), eq(documents.accountId, accountId)))
            .where(tenantWhere(payments, accountId, gte(payments.paidOn, addDays(dates[0], -3)), lte(payments.paidOn, addDays(dates.at(-1), 3)), await businessScope(req, documents.businessId))) : [];
        const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 3 * 86400000;
        return {
            skipped: statement.skipped,
            rows: statement.rows.map((r) => {
                const dup = recorded.find((p) => Math.abs(Number(p.amount) - r.amount) < 0.005 && near(p.paidOn, r.date));
                const s = byLine.get(r.line);
                return { ...r, suggestion: s ? { documentId: s.documentId, confidence: s.confidence } : null, alreadyRecorded: dup ? dup.number : null };
            }),
            open,
        };
    });
    app.post('/api/v1/bank-statement/apply', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = z.object({
            items: z.array(z.object({
                documentId: z.number().int().positive(),
                amount: z.number().positive().max(100_000_000),
                paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                reference: z.string().max(400).optional(),
            })).min(1).max(500),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Nothing to record.' });
        const ids = [...new Set(parsed.data.items.map((i) => i.documentId))];
        const docs = new Map((await db.select().from(documents)
            .where(tenantWhere(documents, accountId, inArray(documents.id, ids)))).map((d) => [d.id, d]));
        let recorded = 0;
        const skipped = [];
        for (const it of parsed.data.items) {
            const doc = docs.get(it.documentId);
            const skip = (reason) => skipped.push({ documentId: it.documentId, number: doc?.number ?? null, reason });
            if (!doc || doc.type !== 'invoice') {
                skip('Not an invoice in this workspace.');
                continue;
            }
            if (doc.businessId && !(await canSeeBusiness(req, doc.businessId))) {
                skip('You do not have access to its business.');
                continue;
            }
            // Read fresh each time: two deposits can go to one invoice in the same run.
            const [cur] = await db.select({ status: documents.status, total: documents.total }).from(documents)
                .where(tenantWhere(documents, accountId, eq(documents.id, doc.id))).limit(1);
            if (cur.status === 'void') {
                skip('It is cancelled.');
                continue;
            }
            if (cur.status !== 'sent') {
                skip(cur.status === 'paid' ? 'It is already paid.' : 'It has not been sent.');
                continue;
            }
            const [same] = await db.select({ id: payments.id }).from(payments)
                .where(tenantWhere(payments, accountId, eq(payments.documentId, doc.id), eq(payments.amount, money(it.amount)), eq(payments.paidOn, it.paidOn))).limit(1);
            if (same) {
                skip('That payment is already recorded.');
                continue;
            }
            const owed = (await balancesFor(accountId, [{ id: doc.id, total: cur.total }])).get(doc.id)?.outstanding ?? Number(cur.total);
            if (it.amount > owed + 0.01) {
                skip(`That is more than the ${formatMoney(owed, doc.currency)} still owed. Record it by hand if it is right.`);
                continue;
            }
            await db.insert(payments).values(withTenant(accountId, {
                documentId: doc.id, amount: money(it.amount), paidOn: it.paidOn, method: 'EFT',
                note: `Bank statement${it.reference ? `: ${it.reference}` : ''}`.slice(0, 255), createdBy: userId,
            }));
            await settleIfCovered(accountId, doc.id, Number(cur.total), cur.status);
            recorded++;
        }
        return { recorded, skipped };
    });
}
//# sourceMappingURL=bankStatement.js.map