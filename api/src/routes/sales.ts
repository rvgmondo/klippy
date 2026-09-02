import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentConnections, sales, businesses } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { assertBusinessAccess, businessScope } from '../lib/access.js';
import { encryptSecret, secretsAvailable } from '../lib/secretbox.js';
import { testKey } from '../lib/yoco.js';
import { syncYoco, taxOutOf } from '../lib/salesSync.js';
import { taxRateFor } from '../lib/taxRateFor.js';
import { currencyFor } from '../lib/currencyFor.js';
import { roundMoney } from '../lib/currency.js';

/**
 * Takings that never went through an invoice.
 *
 * The product companies sell over a counter, so most of their money arrives as a tap
 * on a card machine rather than an invoice somebody chases. Klippy could see none of
 * it, which meant the revenue figures were only ever the agency half of the business
 * and the card fees were invisible entirely.
 *
 * Connecting is admin work on real credentials, so it is gated like the other
 * money settings. Reading the sales is not, so anyone who can see the business can
 * see what it took.
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export async function salesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  /** What each business has connected, without ever handing back the key itself. */
  app.get('/api/v1/sales/connections', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select({
      id: paymentConnections.id, businessId: paymentConnections.businessId,
      provider: paymentConnections.provider, label: paymentConnections.label,
      enabled: paymentConnections.enabled,
      lastSyncedAt: paymentConnections.lastSyncedAt,
      lastSyncedThrough: paymentConnections.lastSyncedThrough,
      lastStatus: paymentConnections.lastStatus,
      hasKey: sql<number>`${paymentConnections.secretEnc} is not null`,
      businessName: businesses.name,
    }).from(paymentConnections)
      .leftJoin(businesses, eq(businesses.id, paymentConnections.businessId))
      .where(tenantWhere(paymentConnections, accountId,
        await businessScope(req, paymentConnections.businessId)));
    return {
      connections: rows.map((r) => ({ ...r, hasKey: !!Number(r.hasKey) })),
      serverReady: secretsAvailable(),
    };
  });

  /**
   * Connect a card machine account, or replace its key.
   *
   * The key is TRIED before it is stored. Saving a credential nobody has proved is
   * how a connection sits there looking configured and quietly pulls nothing for a
   * month, which is worse than not connecting it at all.
   */
  app.put('/api/v1/businesses/:id/sales-connection', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const businessId = intId(req);
    if (!businessId) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, businessId, 'admin'))) return;

    const parsed = z.object({
      provider: z.literal('yoco'),
      secret: z.string().trim().min(10).max(400).optional(),
      label: z.string().trim().max(80).nullable().optional(),
      enabled: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    if (d.secret && !secretsAvailable()) {
      return reply.code(503).send({ error: 'The server cannot store secrets yet. Set PAYMENTS_SECRET in the app environment and restart.' });
    }

    const scope = tenantWhere(paymentConnections, accountId,
      eq(paymentConnections.businessId, businessId), eq(paymentConnections.provider, 'yoco'));
    const [existing] = await db.select().from(paymentConnections).where(scope).limit(1);

    if (d.secret) {
      const trial = await testKey(d.secret);
      if (!trial.ok) return reply.code(400).send({ error: trial.message });
    } else if (!existing?.secretEnc) {
      return reply.code(400).send({ error: 'Add your Yoco API key to connect.' });
    }

    const patch: Record<string, unknown> = {};
    if (d.secret) patch.secretEnc = encryptSecret(d.secret);
    if (d.label !== undefined) patch.label = d.label;
    if (d.enabled !== undefined) patch.enabled = d.enabled;

    if (existing) await db.update(paymentConnections).set(patch).where(scope);
    else {
      await db.insert(paymentConnections).values(withTenant(accountId, {
        businessId, provider: 'yoco' as const, createdBy: userId, ...patch,
      } as never));
    }
    return { ok: true };
  });

  app.delete('/api/v1/businesses/:id/sales-connection', async (req, reply) => {
    const { accountId } = authOf(req);
    const businessId = intId(req);
    if (!businessId) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, businessId, 'admin'))) return;
    // The sales already pulled are kept on purpose: they are this business's takings
    // and its VAT history, not a cache of Yoco's.
    await db.delete(paymentConnections).where(tenantWhere(paymentConnections, accountId,
      eq(paymentConnections.businessId, businessId), eq(paymentConnections.provider, 'yoco')));
    return { ok: true, message: 'Disconnected. The sales already pulled are kept.' };
  });

  /** Pull now, rather than waiting for tonight. */
  app.post('/api/v1/businesses/:id/sales-connection/sync', async (req, reply) => {
    const { accountId } = authOf(req);
    const businessId = intId(req);
    if (!businessId) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, businessId, 'admin'))) return;
    const body = z.object({ fullResync: z.boolean().optional() }).safeParse(req.body ?? {});
    const res = await syncYoco(accountId, businessId, { fullResync: body.success && body.data.fullResync });
    if (!res.ok) return reply.code(400).send({ error: res.message });
    return res;
  });

  /**
   * The takings themselves, and what they actually netted.
   *
   * Three figures matter and all three are shown: what customers paid, what the
   * provider kept, and what reached the bank. Reporting only the gross is how a
   * shop believes it is doing better than its bank balance says.
   */
  app.get('/api/v1/sales', async (req, reply) => {
    const { accountId } = authOf(req);
    const q = z.object({
      from: dateStr, to: dateStr,
      businessId: z.coerce.number().int().positive().optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) required.' });

    const rows = await db.select().from(sales)
      .where(tenantWhere(sales, accountId,
        await businessScope(req, sales.businessId),
        q.data.businessId ? eq(sales.businessId, q.data.businessId) : undefined,
        gte(sales.occurredAt, new Date(`${q.data.from}T00:00:00.000Z`)),
        lte(sales.occurredAt, new Date(`${q.data.to}T23:59:59.999Z`))))
      .orderBy(desc(sales.occurredAt))
      .limit(500);

    // Per currency, never summed across them, same rule as everywhere else.
    const byCurrency = new Map<string, { gross: number; fee: number; net: number; tax: number; count: number }>();
    for (const s of rows) {
      const b = byCurrency.get(s.currency) ?? { gross: 0, fee: 0, net: 0, tax: 0, count: 0 };
      b.gross += Number(s.gross); b.fee += Number(s.fee);
      b.net += Number(s.net); b.tax += Number(s.taxAmount); b.count += 1;
      byCurrency.set(s.currency, b);
    }
    return {
      sales: rows,
      totals: [...byCurrency].map(([currency, b]) => ({
        currency, count: b.count,
        gross: roundMoney(b.gross, currency), fee: roundMoney(b.fee, currency),
        net: roundMoney(b.net, currency), outputVat: roundMoney(b.tax, currency),
      })),
    };
  });

  /**
   * A sale entered by hand.
   *
   * Not every business has a machine Klippy can read, and a cash sale has no gateway
   * at all. Without this the takings screen would only ever be as complete as the
   * integrations, which is a poor reason for a number to be wrong.
   */
  app.post('/api/v1/sales', async (req, reply) => {
    const { accountId } = authOf(req);
    const parsed = z.object({
      businessId: z.number().int().positive(),
      occurredAt: dateStr,
      gross: z.number().positive().max(100_000_000),
      fee: z.number().min(0).max(100_000_000).optional(),
      reference: z.string().trim().max(120).nullable().optional(),
      source: z.string().trim().max(40).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    if (!(await assertBusinessAccess(req, reply, d.businessId, 'member'))) return;

    const currency = await currencyFor(accountId, d.businessId);
    const rate = await taxRateFor(accountId, d.businessId);
    const gross = roundMoney(d.gross, currency);
    const fee = roundMoney(d.fee ?? 0, currency);
    const ins = await db.insert(sales).values(withTenant(accountId, {
      businessId: d.businessId, provider: 'manual' as const, externalId: null,
      source: d.source ?? 'manual', occurredAt: new Date(`${d.occurredAt}T12:00:00.000Z`),
      currency, gross: gross.toFixed(2), fee: fee.toFixed(2),
      net: roundMoney(gross - fee, currency).toFixed(2),
      taxRate: rate.toFixed(2), taxAmount: taxOutOf(gross, rate, currency).toFixed(2),
      status: 'approved', reference: d.reference ?? null,
    }));
    return reply.code(201).send({ id: Number(ins[0].insertId) });
  });

  app.delete('/api/v1/sales/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [row] = await db.select({ businessId: sales.businessId, provider: sales.provider })
      .from(sales).where(tenantWhere(sales, accountId, eq(sales.id, id))).limit(1);
    if (!row) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertBusinessAccess(req, reply, row.businessId, 'admin'))) return;
    // A synced sale would simply come back on the next pull, and deleting it would
    // read as a way to remove a real taking from the VAT figures. Only what somebody
    // typed can be untyped.
    if (row.provider !== 'manual') {
      return reply.code(409).send({
        error: 'This came from your card machine, so it cannot be deleted here. It would return on the next sync anyway.',
      });
    }
    await db.delete(sales).where(tenantWhere(sales, accountId, eq(sales.id, id)));
    return { ok: true };
  });
}
