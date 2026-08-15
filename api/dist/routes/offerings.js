import { money } from '../lib/money.js';
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { offerings, subscriptions } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness } from '../lib/access.js';
import { intId, nextPosition } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';
import { mrrByCurrency } from '../lib/mrr.js';
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
        return { offerings: rows, mrr };
    });
    app.post('/api/v1/offerings', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        const businessId = await resolveBusinessId(accountId, d.businessId);
        if (!businessId)
            return reply.code(400).send({ error: 'No business found for this account.' });
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
        const res = await db.delete(offerings).where(tenantWhere(offerings, accountId, eq(offerings.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Offering not found.' });
        return { ok: true };
    });
}
//# sourceMappingURL=offerings.js.map