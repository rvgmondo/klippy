import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscriptions, offerings, folders } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness } from '../lib/access.js';
import { intId } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';
import { addMonths, generateSubscriptionInvoice } from '../lib/billing.js';
import { money } from '../lib/money.js';
import { suspendForSubscription } from '../lib/hosting.js';

const todayStr = () => new Date().toISOString().slice(0, 10);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const status = z.enum(['active', 'paused', 'canceled']);

export async function subscriptionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // List, with the offering name/price and client name joined in for display.
  app.get('/api/v1/subscriptions', async (req) => {
    const { accountId } = authOf(req);
    const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    const bizFilter = q.success && q.data.businessId ? eq(subscriptions.businessId, q.data.businessId) : undefined;
    const scope = await businessScope(req, subscriptions.businessId);
    const rows = await db.select({
      id: subscriptions.id, businessId: subscriptions.businessId, status: subscriptions.status,
      intervalMonths: subscriptions.intervalMonths,
      startedOn: subscriptions.startedOn, nextBillDate: subscriptions.nextBillDate,
      lastBilledAt: subscriptions.lastBilledAt,
      offeringId: subscriptions.offeringId, offeringName: offerings.name, unit: offerings.unit,
      // Both, so the screen can show the charge AND say it is off the list price.
      listPrice: offerings.price, customPrice: subscriptions.price,
      folderId: subscriptions.folderId, clientName: folders.name,
      autoSend: subscriptions.autoSend,
      autoDebit: subscriptions.autoDebit,
      domain: subscriptions.domain,
      // Whether a card is stored, never the token itself.
      hasCard: sql<boolean>`${subscriptions.payfastToken} is not null`,
    }).from(subscriptions)
      .innerJoin(offerings, eq(offerings.id, subscriptions.offeringId))
      .innerJoin(folders, eq(folders.id, subscriptions.folderId))
      .where(tenantWhere(subscriptions, accountId, bizFilter, scope))
      .orderBy(desc(subscriptions.createdAt));
    return {
      subscriptions: rows.map((r) => ({
        ...r,
        price: r.customPrice ?? r.listPrice,
        isCustomPrice: r.customPrice != null,
      })),
    };
  });

  // Start a subscription: bills the first cycle immediately (as a draft invoice) so
  // the result is visible right away, then schedules the next one a month out.
  app.post('/api/v1/subscriptions', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({
      businessId: z.number().int().positive().optional(),
      offeringId: z.number().int().positive(),
      folderId: z.number().int().positive(),
      startedOn: dateStr.optional(),
      autoSend: z.boolean().optional(),
      domain: z.string().trim().max(190).optional(),
      // 1 monthly, 3 quarterly, 6 half-yearly, 12 annually. Anything up to 5 years.
      intervalMonths: z.number().int().min(1).max(60).optional(),
      // What THIS client pays per cycle. Omit (or null) to charge the list price.
      price: z.number().min(0).max(100_000_000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const [offering] = await db.select().from(offerings)
      .where(tenantWhere(offerings, accountId, eq(offerings.id, d.offeringId))).limit(1);
    if (!offering) return reply.code(404).send({ error: 'Offering not found.' });
    const [folder] = await db.select().from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, d.folderId))).limit(1);
    if (!folder) return reply.code(404).send({ error: 'Client not found.' });

    const businessId = await resolveBusinessId(accountId, d.businessId ?? offering.businessId);
    if (!businessId) return reply.code(400).send({ error: 'No business found for this account.' });
    const startedOn = d.startedOn ?? todayStr();

    const intervalMonths = d.intervalMonths ?? 1;
    const ins = await db.insert(subscriptions).values(withTenant(accountId, {
      businessId, offeringId: d.offeringId, folderId: d.folderId, status: 'active' as const,
      startedOn, nextBillDate: addMonths(startedOn, intervalMonths),
      intervalMonths, autoSend: d.autoSend ?? false, domain: d.domain || null, createdBy: userId,
      // Null when it matches the list price, so the two cases stay distinguishable:
      // a subscription on the list follows a price rise, a negotiated one does not.
      price: d.price == null || d.price === Number(offering.price) ? null : money(d.price),
    }));
    const id = Number(ins[0].insertId);

    try {
      // subscriptionId matters most on THIS invoice. It is the one paid at the
      // point of sale, so it is the one that has to be able to set the service up;
      // without the link it is just an invoice and nothing provisions.
      await generateSubscriptionInvoice(accountId, {
        businessId, offeringId: d.offeringId, folderId: d.folderId,
        createdBy: userId, autoSend: d.autoSend ?? false, subscriptionId: id,
        price: d.price ?? null,
      });
      await db.update(subscriptions).set({ lastBilledAt: new Date() })
        .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id)));
    } catch (err) {
      req.log.error({ err }, 'first subscription invoice failed');
    }

    const [created] = await db.select().from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id))).limit(1);
    return reply.code(201).send({ subscription: created });
  });

  app.patch('/api/v1/subscriptions/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      status: status.optional(), autoSend: z.boolean().optional(), autoDebit: z.boolean().optional(),
      domain: z.string().trim().max(190).nullable().optional(),
      // Retainers get renegotiated. Null puts this client back on the list price.
      price: z.number().min(0).max(100_000_000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const [own] = await db.select({ businessId: subscriptions.businessId }).from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Subscription not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    // Decimals are stored as strings. It takes effect on the NEXT invoice: an
    // invoice already raised is a document the client has, and changing what it
    // says after the fact is what credit notes are for.
    const patch: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.price !== undefined) {
      patch.price = parsed.data.price === null ? null : money(parsed.data.price);
    }
    const res = await db.update(subscriptions).set(patch)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Subscription not found.' });
    // A status change flows through to the hosting it pays for: cancel/pause takes
    // the site down, resume brings it back. Best-effort, so a WHM hiccup never blocks
    // the status change itself.
    if (parsed.data.status === 'canceled' || parsed.data.status === 'paused') {
      await suspendForSubscription(accountId, id, true,
        parsed.data.status === 'paused' ? 'Subscription paused' : 'Subscription cancelled');
    } else if (parsed.data.status === 'active') {
      await suspendForSubscription(accountId, id, false);
    }
    const [updated] = await db.select().from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id))).limit(1);
    return { subscription: updated };
  });

  app.delete('/api/v1/subscriptions/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [own] = await db.select({ businessId: subscriptions.businessId }).from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Subscription not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    // Suspend any hosting first, so deleting the record does not leave a live cPanel
    // account running for free with no subscription pointing at it. The FK then sets
    // the hosting row's subscription_id to null, keeping it visible for teardown.
    await suspendForSubscription(accountId, id, true, 'Subscription deleted');
    const res = await db.delete(subscriptions).where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Subscription not found.' });
    return { ok: true };
  });
}
