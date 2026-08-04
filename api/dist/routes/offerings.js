import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { offerings } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope } from '../lib/access.js';
import { intId, nextPosition } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
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
        const bizFilter = q.success && q.data.businessId ? eq(offerings.businessId, q.data.businessId) : undefined;
        const scope = await businessScope(req, offerings.businessId);
        const rows = await db.select().from(offerings)
            .where(tenantWhere(offerings, accountId, bizFilter, scope))
            .orderBy(asc(offerings.position));
        const mrr = rows.filter((o) => o.recurring && o.active).reduce((s, o) => s + Number(o.price), 0);
        return { offerings: rows, mrr: Math.round(mrr * 100) / 100 };
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
            stockQty: d.stockQty ?? null, reorderPoint: d.reorderPoint ?? null, position, createdBy: userId,
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
        const res = await db.delete(offerings).where(tenantWhere(offerings, accountId, eq(offerings.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Offering not found.' });
        return { ok: true };
    });
}
//# sourceMappingURL=offerings.js.map