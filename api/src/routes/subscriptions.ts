import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { subscriptions, offerings, folders, documents, businesses, accounts } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness } from '../lib/access.js';
import { intId } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';
import { addDays, addMonths, billingAnchor, generateSubscriptionInvoice, upcomingBills } from '../lib/billing.js';
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
      billingDay: subscriptions.billingDay, endsOn: subscriptions.endsOn, notes: subscriptions.notes,
      businessName: businesses.name, currency: sql<string>`COALESCE(${businesses.currency}, ${accounts.currency})`,
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
      .innerJoin(businesses, eq(businesses.id, subscriptions.businessId))
      .innerJoin(accounts, eq(accounts.id, subscriptions.accountId))
      .where(tenantWhere(subscriptions, accountId, bizFilter, scope))
      .orderBy(desc(subscriptions.createdAt));
    return {
      subscriptions: rows.map((r) => ({
        ...r,
        price: r.customPrice ?? r.listPrice,
        isCustomPrice: r.customPrice != null,
        billsOnDay: billingAnchor(r),
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
      endsOn: dateStr.nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
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
    // A start date in the past ("client since August") must not leave the next bill
    // in the past too: the billing run takes one cycle a day, so it would raise a
    // missed month every morning. Starting now bills this cycle (below) and the next
    // one on the same day of the month, from today on.
    let nextBillDate = addMonths(startedOn, intervalMonths);
    // Where the cycle being billed now began, for the period on the first invoice.
    let cycleStart = startedOn;
    for (let i = 0; i < 1200 && nextBillDate <= todayStr(); i++) {
      cycleStart = nextBillDate;
      nextBillDate = addMonths(nextBillDate, intervalMonths, Number(startedOn.slice(8, 10)));
    }
    const ins = await db.insert(subscriptions).values(withTenant(accountId, {
      businessId, offeringId: d.offeringId, folderId: d.folderId, status: 'active' as const,
      startedOn, nextBillDate,
      intervalMonths, autoSend: d.autoSend ?? false, domain: d.domain || null, createdBy: userId,
      endsOn: d.endsOn ?? null, notes: d.notes?.trim() || null,
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
        period: { from: cycleStart, to: addDays(nextBillDate, -1) },
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
      // When the next invoice is raised. Moving it moves the billing day with it,
      // unless a billing day is sent as well.
      nextBillDate: dateStr.optional(),
      billingDay: z.number().int().min(1).max(31).nullable().optional(),
      intervalMonths: z.number().int().min(1).max(60).optional(),
      startedOn: dateStr.optional(),
      endsOn: dateStr.nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
      offeringId: z.number().int().positive().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const [own] = await db.select().from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Subscription not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    const d = parsed.data;
    const today = todayStr();
    // A date in the past would be billed by the next run straight away, which is
    // never what moving a date means. Billing now has its own button.
    if (d.nextBillDate && d.nextBillDate < today && d.nextBillDate !== own.nextBillDate) {
      return reply.code(400).send({ error: 'Pick today or a later date. To bill straight away, use Bill now.' });
    }
    const endsOn = d.endsOn === undefined ? own.endsOn : d.endsOn;
    const startedOn = d.startedOn ?? own.startedOn;
    if (endsOn && endsOn < startedOn) {
      return reply.code(400).send({ error: 'It cannot end before it started.' });
    }
    if (d.offeringId) {
      const [o] = await db.select({ id: offerings.id, businessId: offerings.businessId }).from(offerings)
        .where(tenantWhere(offerings, accountId, eq(offerings.id, d.offeringId))).limit(1);
      if (!o || o.businessId !== own.businessId) {
        return reply.code(400).send({ error: "Pick something from this business's price list." });
      }
    }
    // Decimals are stored as strings. It takes effect on the NEXT invoice: an
    // invoice already raised is a document the client has, and changing what it
    // says after the fact is what credit notes are for.
    const patch: Record<string, unknown> = { ...parsed.data };
    if (d.nextBillDate && d.billingDay === undefined && d.nextBillDate !== own.nextBillDate) {
      patch.billingDay = Number(d.nextBillDate.slice(8, 10));
    }
    if (d.notes !== undefined) patch.notes = d.notes?.trim() || null;
    // Resuming after a long pause: the old date is in the past, and the billing run
    // takes one cycle per day, so it would raise a missed month every morning until
    // it caught up. Months on pause are not owed, so it carries on from today.
    if (d.status === 'active' && own.status !== 'active' && !d.nextBillDate && own.nextBillDate < today) {
      const anchor = billingAnchor({ billingDay: (patch.billingDay as number | null | undefined) ?? own.billingDay, startedOn });
      let next = own.nextBillDate;
      for (let i = 0; i < 1200 && next < today; i++) next = addMonths(next, d.intervalMonths ?? own.intervalMonths, anchor);
      patch.nextBillDate = next;
    }
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

  /**
   * One subscription, with what is coming and what it has already raised, so a
   * change can be made looking at the dates it will affect.
   */
  app.get('/api/v1/subscriptions/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [sub] = await db.select().from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id))).limit(1);
    if (!sub) return reply.code(404).send({ error: 'Subscription not found.' });
    if (!(await assertMaybeBusiness(req, reply, sub.businessId))) return;
    const invoices = await db.select({
      id: documents.id, number: documents.number, issueDate: documents.issueDate, status: documents.status,
      total: documents.total, currency: documents.currency,
    }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.subscriptionId, id)))
      .orderBy(desc(documents.issueDate), desc(documents.id)).limit(24);
    const anchor = billingAnchor(sub);
    return {
      upcoming: sub.status === 'active' ? upcomingBills(sub.nextBillDate, sub.intervalMonths, anchor, 6, sub.endsOn) : [],
      billsOnDay: anchor,
      invoices,
    };
  });

  /**
   * Raise the next cycle's invoice today instead of on its date.
   *
   * Claimed the same way the billing run claims a cycle: the date only moves on if
   * it is still the date this request read, so this and the scheduled run can never
   * both bill the same month. It does not charge a saved card; taking money with
   * nobody watching stays the scheduled run's job, with its own checks.
   */
  app.post('/api/v1/subscriptions/:id/bill-now', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [sub] = await db.select().from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id))).limit(1);
    if (!sub) return reply.code(404).send({ error: 'Subscription not found.' });
    if (!(await assertMaybeBusiness(req, reply, sub.businessId))) return;
    if (sub.status !== 'active') return reply.code(400).send({ error: 'Only an active subscription can be billed. Resume it first.' });
    if (sub.endsOn && sub.nextBillDate > sub.endsOn) return reply.code(400).send({ error: 'This one has reached its end date.' });
    // A double click is not a request to bill two months. The claim below stops two
    // requests billing the SAME cycle; this stops the second one, arriving a moment
    // later, from billing the next cycle as well.
    if (sub.lastBilledAt && Date.now() - new Date(sub.lastBilledAt).getTime() < 2 * 60 * 1000) {
      return reply.code(409).send({ error: 'It was billed a moment ago. Refresh to see the invoice.' });
    }
    const next = addMonths(sub.nextBillDate, sub.intervalMonths, billingAnchor(sub));
    const claim = await db.update(subscriptions).set({ nextBillDate: next, lastBilledAt: new Date() })
      .where(and(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id)),
        eq(subscriptions.nextBillDate, sub.nextBillDate), eq(subscriptions.status, 'active')));
    if (!claim[0].affectedRows) return reply.code(409).send({ error: 'It was just billed. Refresh to see it.' });
    try {
      const docId = await generateSubscriptionInvoice(accountId, {
        businessId: sub.businessId, offeringId: sub.offeringId, folderId: sub.folderId,
        createdBy: userId, autoSend: sub.autoSend, subscriptionId: sub.id,
        price: sub.price != null ? Number(sub.price) : null,
        period: { from: sub.nextBillDate, to: addDays(next, -1) },
      });
      return { ok: true, documentId: docId, billedFor: sub.nextBillDate, nextBillDate: next };
    } catch (err) {
      // Give the cycle back, so a failed invoice does not eat a month.
      await db.update(subscriptions).set({ nextBillDate: sub.nextBillDate })
        .where(and(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id)), eq(subscriptions.nextBillDate, next)));
      req.log.error({ err }, 'bill now failed');
      return reply.code(500).send({ error: 'The invoice could not be made. Nothing was billed.' });
    }
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
