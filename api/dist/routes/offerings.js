import { money } from '../lib/money.js';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { offerings, subscriptions, documents, documentLines } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness } from '../lib/access.js';
import { intId, nextPosition } from '../lib/http.js';
import { businessForNew } from '../lib/business.js';
import { mrrByCurrency } from '../lib/mrr.js';
import { liveHostingForSubscriptions } from '../lib/hosting.js';
const createSchema = z.object({
    businessId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(150),
    description: z.string().max(2000).nullable().optional(),
    price: z.number().min(0).max(1_000_000_000).default(0),
    cost: z.number().min(0).max(1_000_000_000).nullable().optional(),
    unit: z.string().trim().max(30).nullable().optional(),
    recurring: z.boolean().optional(),
    stockQty: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    reorderPoint: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    // Selling this can set something up automatically. 'cpanel' creates a hosting
    // account on the WHM server when an invoice for it is paid.
    provisioning: z.enum(['none', 'cpanel']).optional(),
    whmPackage: z.string().trim().max(60).nullable().optional(),
});
const updateSchema = createSchema.partial().extend({ active: z.boolean().optional() });
// The Offering catalog: what a business actually sells. Same table for every
// business type - a Products business fills in cost/stockQty, a Code business
// sets recurring=true, everyone else mostly just uses name/price/unit.
export async function offeringRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/offerings', async (req) => {
        const { accountId } = authOf(req);
        const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
        const bizId = q.success ? q.data.businessId : undefined;
        const bizFilter = bizId ? eq(subscriptions.businessId, bizId) : undefined;
        const rows = await db.select().from(offerings)
            .where(tenantWhere(offerings, accountId, bizId ? eq(offerings.businessId, bizId) : undefined, await businessScope(req, offerings.businessId)))
            .orderBy(asc(offerings.position));
        // From active SUBSCRIPTIONS, not from this list. Summing the catalogue reported
        // the price list as if it were revenue: ten clients on one retainer counted
        // once, and nobody on it counted the same.
        const mrr = await mrrByCurrency(accountId, [bizFilter, await businessScope(req, subscriptions.businessId)]);
        /**
         * What each item actually does for the business.
         *
         * The list showed prices and nothing about whether anyone buys them, so the
         * question "what sells" was answered from memory. Per item: who is on it now,
         * how many of those follow the list price (and so move when it changes), and
         * what it brought in on issued invoices over the last 12 months.
         */
        const ids = rows.map((o) => o.id);
        const usage = new Map();
        const get = (id) => usage.get(id) ?? usage.set(id, { subscribers: 0, followPrice: 0, sold12m: 0, revenue12m: 0, everUsed: false }).get(id);
        if (ids.length) {
            const subs = await db.select({ offeringId: subscriptions.offeringId, status: subscriptions.status, price: subscriptions.price })
                .from(subscriptions).where(tenantWhere(subscriptions, accountId, inArray(subscriptions.offeringId, ids)));
            for (const x of subs) {
                const u = get(x.offeringId);
                u.everUsed = true;
                if (x.status === 'active') {
                    u.subscribers += 1;
                    if (x.price == null)
                        u.followPrice += 1;
                }
            }
            const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
            // Invoices raised by a subscription did not record their item until October
            // 2026, so for those the item comes from the subscription instead.
            const item = sql `COALESCE(${documentLines.offeringId}, ${subscriptions.offeringId})`;
            const sold = await db.select({
                offeringId: item,
                qty: sql `SUM(${documentLines.quantity})`,
                amount: sql `SUM(${documentLines.amount})`,
            }).from(documentLines)
                .innerJoin(documents, and(eq(documents.id, documentLines.documentId), eq(documents.accountId, accountId)))
                .leftJoin(subscriptions, and(eq(subscriptions.id, documents.subscriptionId), eq(subscriptions.accountId, accountId)))
                .where(tenantWhere(documentLines, accountId, inArray(item, ids), eq(documents.type, 'invoice'), inArray(documents.status, ['sent', 'paid']), gte(documents.issueDate, since)))
                .groupBy(item);
            for (const x of sold) {
                if (x.offeringId == null)
                    continue;
                const u = get(Number(x.offeringId));
                u.sold12m = Math.round(Number(x.qty) * 100) / 100;
                u.revenue12m = Math.round(Number(x.amount) * 100) / 100;
            }
        }
        const shaped = rows.map((o) => ({
            ...o, usage: usage.get(o.id) ?? { subscribers: 0, followPrice: 0, sold12m: 0, revenue12m: 0, everUsed: false },
        }));
        return { offerings: shaped, mrr };
    });
    app.post('/api/v1/offerings', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        const which = await businessForNew(accountId, d.businessId, null);
        if ('error' in which)
            return reply.code(400).send({ error: which.error });
        const businessId = which.id;
        const position = await nextPosition(offerings, sql `account_id = ${accountId} AND business_id = ${businessId}`);
        const ins = await db.insert(offerings).values(withTenant(accountId, {
            businessId, name: d.name, description: d.description ?? null, price: money(d.price),
            cost: d.cost != null ? money(d.cost) : null, unit: d.unit ?? null, recurring: d.recurring ?? false,
            stockQty: d.stockQty ?? null, reorderPoint: d.reorderPoint ?? null,
            provisioning: d.provisioning ?? 'none', whmPackage: d.whmPackage ?? null,
            position, createdBy: userId,
        }));
        const [created] = await db.select().from(offerings)
            .where(tenantWhere(offerings, accountId, eq(offerings.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ offering: created });
    });
    app.patch('/api/v1/offerings/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = updateSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [own] = await db.select({ businessId: offerings.businessId }).from(offerings)
            .where(tenantWhere(offerings, accountId, eq(offerings.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Offering not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        const d = parsed.data;
        const patch = { ...d };
        delete patch.businessId;
        if (d.price !== undefined)
            patch.price = money(d.price);
        if (d.cost !== undefined)
            patch.cost = d.cost != null ? money(d.cost) : null;
        const res = await db.update(offerings).set(patch).where(tenantWhere(offerings, accountId, eq(offerings.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Offering not found.' });
        const [updated] = await db.select().from(offerings).where(tenantWhere(offerings, accountId, eq(offerings.id, id))).limit(1);
        return { offering: updated };
    });
    app.delete('/api/v1/offerings/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [own] = await db.select({ businessId: offerings.businessId }).from(offerings)
            .where(tenantWhere(offerings, accountId, eq(offerings.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Offering not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        // Subscriptions cascade off an offering, and deleting one strands whatever it
        // provisioned on the real server. One click, no Trash, no 30 days to change your
        // mind, so this is the only thing standing between a mis-click and a live client
        // site that can never be billed again.
        const subs = await db.select({ id: subscriptions.id, status: subscriptions.status }).from(subscriptions)
            .where(tenantWhere(subscriptions, accountId, eq(subscriptions.offeringId, id)));
        /**
         * Subscriptions are deleted WITH the offering (the foreign key cascades), so
         * deleting an item somebody pays for every month quietly stopped billing them:
         * no invoice next month, no error, nothing on Subscriptions to say they had
         * ever been on it. Archive keeps every subscription and simply takes the item
         * off the menu for new work, so that is the way out while anyone is on it.
         */
        const onIt = subs.filter((x) => x.status !== 'canceled').length;
        if (onIt) {
            return reply.code(409).send({
                error: `${onIt} subscription${onIt === 1 ? ' is' : 's are'} on this, so deleting it would stop that billing. Archive it instead: it leaves the price list for new work and the subscriptions keep running.`,
            });
        }
        if (subs.length) {
            return reply.code(409).send({
                error: 'Past subscriptions were on this, and deleting it would delete their history. Archive it instead.',
            });
        }
        const live = await liveHostingForSubscriptions(accountId, subs.map((s) => s.id));
        if (live.length) {
            const names = [...new Set(live.map((h) => h.domain))].slice(0, 3).join(', ');
            return reply.code(409).send({
                error: `Clients on this offering still have hosting on the server (${names}). Switch it off on the Hosting screen first.`,
            });
        }
        const res = await db.delete(offerings).where(tenantWhere(offerings, accountId, eq(offerings.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Offering not found.' });
        return { ok: true };
    });
}
//# sourceMappingURL=offerings.js.map