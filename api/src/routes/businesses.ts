import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, accounts, businessMembers, businessEmail, memberships, users } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId, nextPosition } from '../lib/http.js';
import { seedNewBusiness } from '../lib/seed.js';
import { accessibleBusinessIds, assertBusinessAccess } from '../lib/access.js';
import { encryptSecret, secretsAvailable } from '../lib/secretbox.js';

const businessType = z.enum(['services', 'products', 'code', 'content']);
const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  type: businessType.default('services'),
  color: z.string().trim().max(20).optional(),
});
const nullableStr = (max: number) => z.string().trim().max(max).nullable().optional().or(z.literal(''));
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  color: z.string().trim().max(20).optional(),
  secondaryTypes: z.array(businessType).max(4).optional(),
  notes: z.string().max(20000).nullable().optional(),
  // Brand + invoicing identity.
  brandName: nullableStr(80),
  bizAddress: nullableStr(500),
  bizTaxNumber: nullableStr(60),
  bizRegNumber: nullableStr(60),
  bankDetails: nullableStr(2000),
  invoiceFooter: nullableStr(2000),
  invoiceAccent: z.string().trim().max(20).optional(),
  defaultTaxRate: z.number().min(0).max(100).nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).optional(),
  // Reminder schedule.
  remindersEnabled: z.boolean().optional(),
  reminderOffsets: z.array(z.number().int().min(-60).max(365)).max(10).nullable().optional(),
  suspendAfterDays: z.number().int().min(0).max(365).nullable().optional(),
});

export async function businessRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // The businesses this user may see: all of them for an account owner/admin, only
  // the assigned ones for a member. This drives the switcher, sidebar and dashboard,
  // so scoping it here scopes what a member sees across the app.
  app.get('/api/v1/businesses', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select().from(businesses)
      .where(tenantWhere(businesses, accountId))
      .orderBy(asc(businesses.position));
    const allowed = await accessibleBusinessIds(req);
    return { businesses: allowed ? rows.filter((b) => allowed.has(b.id)) : rows };
  });

  app.post('/api/v1/businesses', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const position = await nextPosition(businesses, sql`account_id = ${accountId}`);

    // A new business starts from the account's invoicing defaults (address, bank
    // details, tax rate, etc.), so it is self-contained and editable in its own
    // Business Settings rather than depending on an account-level fallback.
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);

    // Create the business on its own. `secondaryTypes` is written explicitly rather
    // than leaning on the column's DEFAULT, because a JSON default needs MySQL
    // 8.0.13+ and a strict-mode server rejects the insert outright without it.
    const ins = await db.insert(businesses).values(withTenant(accountId, {
      name: parsed.data.name, type: parsed.data.type, color: parsed.data.color ?? '#6366f1',
      secondaryTypes: [], position, createdBy: userId,
      bizAddress: acc?.bizAddress ?? null, bizTaxNumber: acc?.bizTaxNumber ?? null,
      bizRegNumber: acc?.bizRegNumber ?? null, bankDetails: acc?.bankDetails ?? null,
      invoiceFooter: acc?.invoiceFooter ?? null, invoiceAccent: acc?.invoiceAccent ?? '#6366f1',
      defaultTaxRate: acc?.defaultTaxRate ?? null, defaultDueDays: acc?.defaultDueDays ?? 14,
    }));
    const businessId = Number(ins[0].insertId);

    // Seeding example content is a convenience, not part of creating the business.
    // It touches five more tables, so if any of them trips, the business must still
    // exist rather than the whole thing rolling back into a 500.
    try {
      await db.transaction(async (tx) => {
        await seedNewBusiness(tx, accountId, userId, businessId, parsed.data.type);
      });
    } catch (err) {
      req.log.error({ err, businessId }, 'business created but seeding its example content failed');
    }

    const [row] = await db.select().from(businesses)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1);
    return reply.code(201).send({ business: row });
  });

  app.patch('/api/v1/businesses/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    // Changing a business's settings (brand, invoicing) needs admin on it.
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const patch: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.secondaryTypes) {
      const [existing] = await db.select({ type: businesses.type }).from(businesses)
        .where(tenantWhere(businesses, accountId, eq(businesses.id, id))).limit(1);
      patch.secondaryTypes = [...new Set(parsed.data.secondaryTypes)].filter((t) => t !== existing?.type);
    }
    // Empty strings from the form mean "clear it"; decimals are stored as strings.
    for (const k of ['brandName', 'bizAddress', 'bizTaxNumber', 'bizRegNumber', 'bankDetails', 'invoiceFooter'] as const) {
      if (patch[k] === '') patch[k] = null;
    }
    if (parsed.data.defaultTaxRate !== undefined) {
      patch.defaultTaxRate = parsed.data.defaultTaxRate === null ? null : String(parsed.data.defaultTaxRate);
    }
    const res = await db.update(businesses).set(patch)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Business not found.' });
    const [updated] = await db.select().from(businesses)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, id))).limit(1);
    return { business: updated };
  });

  app.delete('/api/v1/businesses/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    // Refuse to delete the last business, so an account always has at least one.
    const [countRow] = await db.select({ n: sql<number>`count(*)` }).from(businesses)
      .where(tenantWhere(businesses, accountId));
    if (Number(countRow?.n ?? 0) <= 1) return reply.code(400).send({ error: 'You need at least one business.' });
    const res = await db.delete(businesses).where(tenantWhere(businesses, accountId, eq(businesses.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Business not found.' });
    return { ok: true };
  });

  // ---- Access: who can see/work in this business, and at what role -----------
  // Managing access needs admin on the business (account owners/admins qualify).
  app.get('/api/v1/businesses/:id/members', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;

    // Everyone in the account, annotated with their access to THIS business. Account
    // owners/admins are shown as full-access and not editable per business.
    const people = await db.select({
      userId: memberships.userId, name: users.name, email: users.email, accountRole: memberships.role,
    }).from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.accountId, accountId), eq(memberships.isActive, true)));
    const assigned = await db.select({ userId: businessMembers.userId, role: businessMembers.role })
      .from(businessMembers)
      .where(and(eq(businessMembers.accountId, accountId), eq(businessMembers.businessId, id)));
    const roleByUser = new Map(assigned.map((a) => [a.userId, a.role]));

    return {
      members: people.map((p) => ({
        userId: p.userId, name: p.name, email: p.email,
        // Owners/admins implicitly have full access to every business.
        accountAdmin: p.accountRole === 'owner' || p.accountRole === 'admin',
        role: roleByUser.get(p.userId) ?? null, // null = no access (for plain members)
      })),
    };
  });

  app.put('/api/v1/businesses/:id/members/:userId', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    const userId = Number((req.params as { userId: string }).userId);
    if (!id || !userId) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    const parsed = z.object({ role: z.enum(['admin', 'member', 'viewer']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'role must be admin, member or viewer.' });

    // Only a real account member can be given per-business access.
    const [m] = await db.select({ role: memberships.role }).from(memberships)
      .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, userId), eq(memberships.isActive, true))).limit(1);
    if (!m) return reply.code(404).send({ error: 'That person is not in this account.' });
    if (m.role === 'owner' || m.role === 'admin') {
      return reply.code(400).send({ error: 'Account admins already have access to every business.' });
    }

    const [existing] = await db.select({ id: businessMembers.id }).from(businessMembers)
      .where(and(eq(businessMembers.businessId, id), eq(businessMembers.userId, userId))).limit(1);
    if (existing) {
      await db.update(businessMembers).set({ role: parsed.data.role }).where(eq(businessMembers.id, existing.id));
    } else {
      await db.insert(businessMembers).values({ accountId, businessId: id, userId, role: parsed.data.role });
    }
    return { ok: true };
  });

  app.delete('/api/v1/businesses/:id/members/:userId', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    const userId = Number((req.params as { userId: string }).userId);
    if (!id || !userId) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    await db.delete(businessMembers)
      .where(and(eq(businessMembers.accountId, accountId), eq(businessMembers.businessId, id), eq(businessMembers.userId, userId)));
    return { ok: true };
  });

  // ---- Per-business email settings ------------------------------------------
  // How this business's mail is addressed, and optionally its own SMTP server.
  // Secrets (the SMTP password) are never returned; the UI shows whether one is set.
  app.get('/api/v1/businesses/:id/email', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    const [row] = await db.select().from(businessEmail)
      .where(and(eq(businessEmail.accountId, accountId), eq(businessEmail.businessId, id))).limit(1);
    return {
      email: {
        fromName: row?.fromName ?? '', fromEmail: row?.fromEmail ?? '', replyTo: row?.replyTo ?? '',
        invoiceFromName: row?.invoiceFromName ?? '', invoiceFromEmail: row?.invoiceFromEmail ?? '',
        invoiceReplyTo: row?.invoiceReplyTo ?? '',
        smtpHost: row?.smtpHost ?? '', smtpPort: row?.smtpPort ?? null,
        smtpSecure: row?.smtpSecure ?? false, smtpUser: row?.smtpUser ?? '',
        hasSmtpPass: !!row?.smtpPassEnc,
      },
      // The shared sending address, shown as the fallback when fields are blank.
      globalFrom: process.env.SMTP_FROM ?? null,
      secretsReady: secretsAvailable(),
    };
  });

  app.patch('/api/v1/businesses/:id/email', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    const em = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));
    const parsed = z.object({
      fromName: em(120), fromEmail: em(150), replyTo: em(150),
      invoiceFromName: em(120), invoiceFromEmail: em(150), invoiceReplyTo: em(150),
      smtpHost: em(200), smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
      smtpSecure: z.boolean().optional(), smtpUser: em(200), smtpPass: em(200),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    if (d.smtpPass && !secretsAvailable()) {
      return reply.code(503).send({ error: 'The server cannot store an SMTP password yet. Set PAYMENTS_SECRET and restart.' });
    }

    const blankToNull = (v: string | undefined) => (v === undefined ? undefined : (v === '' ? null : v));
    const patch: Record<string, unknown> = {
      fromName: blankToNull(d.fromName), fromEmail: blankToNull(d.fromEmail), replyTo: blankToNull(d.replyTo),
      invoiceFromName: blankToNull(d.invoiceFromName), invoiceFromEmail: blankToNull(d.invoiceFromEmail),
      invoiceReplyTo: blankToNull(d.invoiceReplyTo),
      smtpHost: blankToNull(d.smtpHost), smtpUser: blankToNull(d.smtpUser),
    };
    if (d.smtpPort !== undefined) patch.smtpPort = d.smtpPort;
    if (d.smtpSecure !== undefined) patch.smtpSecure = d.smtpSecure;
    if (d.smtpPass) patch.smtpPassEnc = encryptSecret(d.smtpPass);
    else if (d.smtpPass === '') patch.smtpPassEnc = null;
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];

    const [existing] = await db.select({ id: businessEmail.id }).from(businessEmail)
      .where(and(eq(businessEmail.accountId, accountId), eq(businessEmail.businessId, id))).limit(1);
    if (existing) {
      await db.update(businessEmail).set(patch).where(eq(businessEmail.id, existing.id));
    } else {
      await db.insert(businessEmail).values({ accountId, businessId: id, ...patch });
    }
    return { ok: true };
  });

  // Persist order after drag/drop.
  app.post('/api/v1/businesses/reorder', async (req, reply) => {
    const { accountId } = authOf(req);
    const body = z.object({ orderedIds: z.array(z.number().int().positive()).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'orderedIds required.' });
    await db.transaction(async (tx) => {
      for (let i = 0; i < body.data.orderedIds.length; i++) {
        await tx.update(businesses).set({ position: i })
          .where(and(eq(businesses.accountId, accountId), eq(businesses.id, body.data.orderedIds[i]!)));
      }
    });
    return { ok: true };
  });
}
