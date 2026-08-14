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
import { MODULES, PRIMITIVES, PRIMITIVE_LABEL, PRIMITIVE_BLURB, effectiveModules } from '../lib/modules.js';
import { BLUEPRINTS, blueprint, provisionFrom } from '../lib/blueprints.js';
import { ALLOWED_FONTS, isAllowedFont } from '../lib/fonts.js';
import { sanitiseTemplate, PLACEHOLDERS } from '../lib/template.js';
import { nextNumberFor } from '../lib/numbering.js';
import { PDF_TEMPLATES, PDF_TYPEFACES, ISSUER_PLACEMENTS, TEMPLATE_INFO, TYPEFACE_INFO, PLACEMENT_INFO } from '../lib/pdfThemes.js';
import { renderSamplePdf } from '../lib/pdf.js';
import { isKnownCurrency } from '../lib/currency.js';

const businessType = z.enum(['services', 'products', 'code', 'content']);
const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  type: businessType.default('services'),
  color: z.string().trim().max(20).optional(),
  // A named preset ("Hosting", "Shop"). Decides the type, modules and billing
  // defaults, so the app arrives arranged for how this business actually runs.
  blueprint: z.string().trim().max(40).optional(),
});
const nullableStr = (max: number) => z.string().trim().max(max).nullable().optional().or(z.literal(''));
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  color: z.string().trim().max(20).optional(),
  secondaryTypes: z.array(businessType).max(4).optional(),
  notes: z.string().max(20000).nullable().optional(),
  // Brand + invoicing identity.
  brandName: nullableStr(80),
  // What this business bills in. Null (or blank) means "use the workspace
  // currency", which is what all but multi-country accounts stay on.
  currency: z.string().trim().nullable().optional()
    .refine((v) => v == null || v === '' || (v.length === 3 && isKnownCurrency(v)),
      'That is not a currency Klippy knows.'),
  bizAddress: nullableStr(500),
  bizTaxNumber: nullableStr(60),
  bizRegNumber: nullableStr(60),
  bankDetails: nullableStr(2000),
  invoiceFooter: nullableStr(2000),
  invoiceAccent: z.string().trim().max(20).optional(),
  defaultTaxRate: z.number().min(0).max(100).nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).optional(),
  // Which modules show. Null resets to the business type's defaults.
  modules: z.array(z.string().max(40)).max(40).nullable().optional(),
  // Typefaces. Checked against the allow-list here rather than trusting the
  // client, since the family name is later interpolated into CSS.
  fontDisplay: z.string().max(60).nullable().optional().refine(
    (v) => v == null || v === '' || isAllowedFont(v), 'That font is not on the list.'),
  fontBody: z.string().max(60).nullable().optional().refine(
    (v) => v == null || v === '' || isAllowedFont(v), 'That font is not on the list.'),
  // PDF design.
  pdfTemplate: z.enum(PDF_TEMPLATES).nullable().optional(),
  pdfTypeface: z.enum(PDF_TYPEFACES).nullable().optional(),
  pdfIssuerPlacement: z.enum(ISSUER_PLACEMENTS).nullable().optional(),
  // Document numbering: prefix per type, and where the count starts.
  prefixInvoice: nullableStr(12),
  prefixQuote: nullableStr(12),
  prefixCreditNote: nullableStr(12),
  seqStartInvoice: z.number().int().min(1).max(9_999_999).nullable().optional(),
  seqStartQuote: z.number().int().min(1).max(9_999_999).nullable().optional(),
  seqStartCreditNote: z.number().int().min(1).max(9_999_999).nullable().optional(),
  // Custom document blocks. Accepted as typed, then sanitised below.
  invoiceHeaderHtml: z.string().max(20000).nullable().optional(),
  invoiceFooterHtml: z.string().max(20000).nullable().optional(),
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
    const visible = allowed ? rows.filter((b) => allowed.has(b.id)) : rows;
    // Resolve modules here so the client never has to know the defaulting rules.
    return {
      businesses: visible.map((b) => ({
        ...b,
        modules: effectiveModules(b.modules, b.type, b.secondaryTypes ?? []),
      })),
    };
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
    // A blueprint decides the type and how this business is set up; without one we
    // fall back to the plain type, which is how businesses were always created.
    const bp = blueprint(parsed.data.blueprint);
    const prov = bp ? provisionFrom(bp) : null;
    const type = prov?.type ?? parsed.data.type;

    const ins = await db.insert(businesses).values(withTenant(accountId, {
      name: parsed.data.name, type, color: parsed.data.color ?? '#6366f1',
      secondaryTypes: [], position, createdBy: userId,
      modules: prov?.modules ?? null,
      bizAddress: acc?.bizAddress ?? null, bizTaxNumber: acc?.bizTaxNumber ?? null,
      bizRegNumber: acc?.bizRegNumber ?? null, bankDetails: acc?.bankDetails ?? null,
      invoiceFooter: acc?.invoiceFooter ?? null, invoiceAccent: acc?.invoiceAccent ?? '#6366f1',
      defaultTaxRate: prov?.defaultTaxRate != null ? String(prov.defaultTaxRate) : (acc?.defaultTaxRate ?? null),
      defaultDueDays: prov?.defaultDueDays ?? acc?.defaultDueDays ?? 14,
      ...(prov?.reminderOffsets ? { reminderOffsets: prov.reminderOffsets } : {}),
      ...(prov?.suspendAfterDays !== undefined ? { suspendAfterDays: prov.suspendAfterDays } : {}),
    }));
    const businessId = Number(ins[0].insertId);

    // Seeding example content is a convenience, not part of creating the business.
    // It touches five more tables, so if any of them trips, the business must still
    // exist rather than the whole thing rolling back into a 500.
    try {
      await db.transaction(async (tx) => {
        await seedNewBusiness(tx, accountId, userId, businessId, type);
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
    for (const k of ['brandName', 'bizAddress', 'bizTaxNumber', 'bizRegNumber', 'bankDetails', 'invoiceFooter', 'fontDisplay', 'fontBody', 'currency'] as const) {
      if (patch[k] === '') patch[k] = null;
    }
    // Stored upper case, so nothing downstream has to normalise it.
    if (typeof patch.currency === 'string') patch.currency = patch.currency.toUpperCase();
    if (parsed.data.defaultTaxRate !== undefined) {
      patch.defaultTaxRate = parsed.data.defaultTaxRate === null ? null : String(parsed.data.defaultTaxRate);
    }
    // Sanitise templates on the way IN, so nothing unsafe is ever stored and every
    // reader gets clean markup without having to remember to clean it.
    for (const k of ['invoiceHeaderHtml', 'invoiceFooterHtml'] as const) {
      if (parsed.data[k] !== undefined) {
        patch[k] = parsed.data[k] ? sanitiseTemplate(parsed.data[k]!) || null : null;
      }
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

  // The module catalogue: what exists, which primitive it belongs to, and what each
  // one is for. Static, but served so the client and server cannot drift apart.
  app.get('/api/v1/fonts', async () => ({ fonts: ALLOWED_FONTS }));

  // What a template may refer to, so the editor's help and the renderer agree.
  app.get('/api/v1/template-placeholders', async () => ({ placeholders: PLACEHOLDERS }));

  app.get('/api/v1/blueprints', async () => ({
    blueprints: BLUEPRINTS.map((b) => ({ key: b.key, label: b.label, type: b.type, blurb: b.blurb })),
  }));

  app.get('/api/v1/modules', async () => ({
    primitives: PRIMITIVES.map((p) => ({ key: p, label: PRIMITIVE_LABEL[p], blurb: PRIMITIVE_BLURB[p] })),
    modules: MODULES.map((m) => ({
      key: m.key, label: m.label, primitive: m.primitive, core: !!m.core, hint: m.hint,
    })),
  }));

  /**
   * Where this business's numbering stands: the prefix, the highest number already
   * used, and what the next one will be. Shown in settings so changing a prefix or
   * a starting number is not a guess.
   */
  app.get('/api/v1/businesses/:id/numbering', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    const types = ['invoice', 'quote', 'credit_note'] as const;
    const out: Record<string, { prefix: string; nextNumber: string; nextSeq: number; highestUsed: number }> = {};
    for (const t of types) {
      const n = await nextNumberFor(accountId, id, t);
      out[t] = { prefix: n.prefix, nextNumber: n.number, nextSeq: n.seq, highestUsed: n.highestUsed };
    }
    return { numbering: out };
  });

  /** The PDF designs on offer, so the picker and the renderer cannot drift. */
  app.get('/api/v1/pdf-designs', async () => ({
    templates: TEMPLATE_INFO, typefaces: TYPEFACE_INFO, placements: PLACEMENT_INFO,
  }));

  /**
   * A worked example in a chosen design, using this business's own brand, logo and
   * details. Seeing the actual document matters when the thing being chosen is what
   * every client receives, and a swatch would not tell you.
   */
  app.get('/api/v1/businesses/:id/pdf-preview', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    const q = req.query as { template?: string; typeface?: string; issuer?: string };
    const buf = await renderSamplePdf(accountId, id, {
      template: q.template, typeface: q.typeface, issuer: q.issuer,
    });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline; filename="preview.pdf"')
      .send(buf);
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
