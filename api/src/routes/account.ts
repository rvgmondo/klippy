import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, isNotNull, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { buildAccountExport } from '../lib/export.js';
import { CURRENCIES, isKnownCurrency } from '../lib/currency.js';
import { publicAccount } from '../lib/publicAccount.js';
import { businesses, businessMembers, businessEmail, memberships, users, teams, teamMembers, hostingSettings, paymentSettings, folders, deals, offerings, boards, boardColumns, tasks, timeEntries, contacts, documents, documentLines, payments, subscriptions, expenses } from '../db/schema.js';
import { TEMPLATES } from '../lib/templates.js';
import { inArray, isNull, or } from 'drizzle-orm';
import { and } from 'drizzle-orm';

const nullableStr = (max: number) => z.string().trim().max(max).nullable().optional().or(z.literal(''));
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  folderLabelSingular: z.string().trim().min(1).max(40).optional(),
  folderLabelPlural: z.string().trim().min(1).max(40).optional(),
  brandName: z.string().trim().max(80).nullable().optional(),
  // Checked against the list, not just the length: a typo here silently relabels
  // every future invoice, and the currency is copied onto documents at issue time
  // so it cannot be corrected in one place afterwards.
  currency: z.string().trim().length(3).transform((v) => v.toUpperCase())
    .refine(isKnownCurrency, 'That is not a currency Klippy knows.').optional(),
  // Invoicing settings.
  bizAddress: nullableStr(500),
  bizTaxNumber: nullableStr(60),
  bizRegNumber: nullableStr(60),
  bankDetails: nullableStr(2000),
  invoiceFooter: nullableStr(2000),
  invoiceAccent: z.string().trim().max(20).optional(),
  defaultTaxRate: z.number().min(0).max(100).nullable().optional(),
  defaultDueDays: z.number().int().min(0).max(365).optional(),
});


/** The invoicing settings, as the settings form and the invoice template read them. */
function invoicingSettings(a: typeof accounts.$inferSelect) {
  return {
    brandName: a.brandName, hasLogo: !!a.logoPath, currency: a.currency,
    bizAddress: a.bizAddress, bizTaxNumber: a.bizTaxNumber, bizRegNumber: a.bizRegNumber,
    bankDetails: a.bankDetails, invoiceFooter: a.invoiceFooter,
    invoiceAccent: a.invoiceAccent,
    defaultTaxRate: a.defaultTaxRate != null ? Number(a.defaultTaxRate) : null,
    defaultDueDays: a.defaultDueDays,
  };
}

export async function accountRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  /**
   * The currencies on offer, for any picker that needs them.
   *
   * Served rather than duplicated in the web bundle so there is one list. Static,
   * so it needs no tenant scoping beyond being behind auth.
   */
  app.get('/api/v1/currencies', async () => ({ currencies: CURRENCIES }));

  // The invoicing settings, for the settings screen to load into its form.
  app.get('/api/v1/account/invoicing', async (req, reply) => {
    const { accountId } = authOf(req);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!a) return reply.code(404).send({ error: 'Account not found.' });
    return { invoicing: invoicingSettings(a) };
  });

  // Update workspace settings (owner/admin only).
  app.patch('/api/v1/account', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') {
      return reply.code(403).send({ error: 'Only workspace admins can change settings.' });
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'Nothing to update.' });
    }
    // Empty strings from the form mean "clear it", and numbers become DECIMAL strings.
    const patch: Record<string, unknown> = { ...parsed.data };
    for (const k of ['bizAddress', 'bizTaxNumber', 'bizRegNumber', 'bankDetails', 'invoiceFooter'] as const) {
      if (patch[k] === '') patch[k] = null;
    }
    if (parsed.data.defaultTaxRate !== undefined) {
      patch.defaultTaxRate = parsed.data.defaultTaxRate === null ? null : String(parsed.data.defaultTaxRate);
    }
    await db.update(accounts).set(patch).where(eq(accounts.id, accountId));
    const [updated] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!updated) return reply.code(404).send({ error: 'Account not found.' });
    return { account: publicAccount(updated), invoicing: invoicingSettings(updated) };
  });

  /**
   * The Connections roll-up: which merchant account, hosting server and sender each
   * business ACTUALLY resolves to. Per-business overrides are correct for separate
   * legal entities, but only a roll-up makes a mis-wiring visible, and money or a
   * client site landing in the wrong entity is a silent, expensive error.
   */
  app.get('/api/v1/connections', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only workspace admins can see connections.' });

    const [bizRows, pay, host, mail] = await Promise.all([
      db.select({ id: businesses.id, name: businesses.name }).from(businesses)
        .where(eq(businesses.accountId, accountId)),
      db.select({ businessId: paymentSettings.businessId, enabled: paymentSettings.enabled, merchantId: paymentSettings.merchantId })
        .from(paymentSettings).where(eq(paymentSettings.accountId, accountId)),
      db.select({ businessId: hostingSettings.businessId, enabled: hostingSettings.enabled, host: hostingSettings.whmHost, live: hostingSettings.live })
        .from(hostingSettings).where(eq(hostingSettings.accountId, accountId)),
      db.select({ businessId: businessEmail.businessId, fromEmail: businessEmail.fromEmail })
        .from(businessEmail).where(eq(businessEmail.accountId, accountId)),
    ]);

    const resolve = <T extends { businessId: number }>(rows: T[], bizId: number) => {
      const own = rows.find((r) => r.businessId === bizId);
      if (own) return { scope: 'own' as const, row: own };
      const ws = rows.find((r) => r.businessId === 0);
      if (ws) return { scope: 'workspace' as const, row: ws };
      return { scope: 'none' as const, row: null };
    };

    return {
      businesses: bizRows.map((b) => {
        const p2 = resolve(pay, b.id);
        const h = resolve(host, b.id);
        const m = resolve(mail, b.id);
        return {
          businessId: b.id,
          name: b.name,
          payments: {
            scope: p2.scope,
            enabled: !!(p2.row && 'enabled' in p2.row && p2.row.enabled),
            merchantId: p2.row && 'merchantId' in p2.row ? p2.row.merchantId : null,
          },
          hosting: {
            scope: h.scope,
            enabled: !!(h.row && 'enabled' in h.row && h.row.enabled),
            live: !!(h.row && 'live' in h.row && h.row.live),
            host: h.row && 'host' in h.row ? h.row.host : null,
          },
          email: {
            scope: m.scope,
            from: m.row && 'fromEmail' in m.row ? m.row.fromEmail : null,
          },
        };
      }),
    };
  });

  /**
   * The access grid: one answer to "what can this person touch?". Account role,
   * per-business access, and team memberships in a single payload, so the People
   * screen can show and edit them together instead of across three screens.
   */
  app.get('/api/v1/access-grid', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only workspace admins can see the access grid.' });

    const [people, bizRows, grants, teamRows, teamMemberRows] = await Promise.all([
      db.select({ userId: memberships.userId, name: users.name, email: users.email, role: memberships.role, isActive: memberships.isActive })
        .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.accountId, accountId)),
      db.select({ id: businesses.id, name: businesses.name }).from(businesses)
        .where(eq(businesses.accountId, accountId)),
      db.select({ userId: businessMembers.userId, businessId: businessMembers.businessId, role: businessMembers.role })
        .from(businessMembers).where(eq(businessMembers.accountId, accountId)),
      db.select({ id: teams.id, name: teams.name, color: teams.color }).from(teams)
        .where(eq(teams.accountId, accountId)),
      db.select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
        .from(teamMembers).innerJoin(teams, and(eq(teams.id, teamMembers.teamId), eq(teams.accountId, accountId))),
    ]);

    return {
      businesses: bizRows,
      people: people.map((p) => ({
        ...p,
        access: grants.filter((g) => g.userId === p.userId).map((g) => ({ businessId: g.businessId, role: g.role })),
        teams: teamMemberRows.filter((t) => t.userId === p.userId)
          .map((t) => teamRows.find((x) => x.id === t.teamId))
          .filter((x): x is NonNullable<typeof x> => !!x),
      })),
    };
  });

  /**
   * Example data, honestly labelled and disposable.
   *
   * A fresh workspace is seeded with a working example (a sample client, deals,
   * offerings) because a blank app is worse. But that example used to show
   * FABRICATED MONEY as if it were the founder's own: an R44,500 pipeline from
   * "Example Co", sample offerings feeding real MRR, with no label and no way out.
   * These endpoints let Home say what is example and clear it in one click.
   *
   * Matching is by the EXACT names the seed templates use, derived from the
   * templates themselves so the two can never drift, and never by pattern, so a
   * real client someone happened to call "Sample..." plus anything renamed even
   * slightly is left alone.
   */
  app.get('/api/v1/account/samples', async (req) => {
    const { accountId } = authOf(req);
    const names = sampleNames();
    const [f, d, o] = await Promise.all([
      db.select({ id: folders.id }).from(folders)
        .where(and(eq(folders.accountId, accountId), isNull(folders.parentId), inArray(folders.name, names.folders))),
      db.select({ id: deals.id }).from(deals)
        .where(and(eq(deals.accountId, accountId), inArray(deals.company, names.companies))),
      db.select({ id: offerings.id }).from(offerings)
        .where(and(eq(offerings.accountId, accountId), inArray(offerings.name, names.offerings))),
    ]);
    return { present: f.length + d.length + o.length > 0, folders: f.length, deals: d.length, offerings: o.length };
  });

  app.post('/api/v1/account/clear-samples', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only workspace admins can clear example data.' });
    const names = sampleNames();
    // Folders cascade to their boards and cards.
    const f = await db.delete(folders)
      .where(and(eq(folders.accountId, accountId), isNull(folders.parentId), inArray(folders.name, names.folders)));
    const d = await db.delete(deals)
      .where(and(eq(deals.accountId, accountId), inArray(deals.company, names.companies)));
    const o = await db.delete(offerings)
      .where(and(eq(offerings.accountId, accountId), inArray(offerings.name, names.offerings)));
    return { ok: true, removed: { folders: f[0].affectedRows, deals: d[0].affectedRows, offerings: o[0].affectedRows } };
  });

  /**
   * Everything, in one file the founder owns.
   *
   * The whole business lived in a shared-hosting database with no in-app way out,
   * which is a personal risk today (one bad migration from losing it) and a POPIA /
   * due-diligence expectation the moment Klippy is sold to anyone else. One JSON
   * document, admin-only: clients, work, time, money, the lot. Secrets
   * (credentials, tokens, password hashes) stay out by construction because each
   * table lists its columns explicitly.
   */

  /**
   * The first-run checklist, computed rather than stored: each step is "does the
   * thing exist yet", so it ticks itself the moment the work is done and can
   * never drift out of step with reality.
   */
  app.get('/api/v1/onboarding', async (req) => {
    const { accountId } = authOf(req);
    const exists = async (q: Promise<unknown[]>) => (await q).length > 0;
    const [client, brand, offering, deal, invoice, pay] = await Promise.all([
      exists(db.select({ id: folders.id }).from(folders)
        .where(tenantWhere(folders, accountId, isNull(folders.parentId), eq(folders.pillar, 'delivery'), isNull(folders.deletedAt))).limit(1)),
      exists(db.select({ id: businesses.id }).from(businesses)
        .where(tenantWhere(businesses, accountId, isNotNull(businesses.brandName))).limit(1)),
      exists(db.select({ id: offerings.id }).from(offerings)
        .where(tenantWhere(offerings, accountId)).limit(1)),
      exists(db.select({ id: deals.id }).from(deals)
        .where(tenantWhere(deals, accountId)).limit(1)),
      exists(db.select({ id: documents.id }).from(documents)
        .where(tenantWhere(documents, accountId, eq(documents.type, 'invoice'), ne(documents.status, 'draft'))).limit(1)),
      exists(db.select({ id: paymentSettings.id }).from(paymentSettings)
        .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.enabled, true))).limit(1)),
    ]);
    return {
      steps: [
        { key: 'client', done: client },
        { key: 'brand', done: brand },
        { key: 'offering', done: offering },
        { key: 'deal', done: deal },
        { key: 'invoice', done: invoice },
        { key: 'payments', done: pay },
      ],
    };
  });

  app.get('/api/v1/account/export', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only workspace admins can export the workspace.' });
    const data = await buildAccountExport(accountId);
    const today = new Date().toISOString().slice(0, 10);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="klippy-export-${today}.json"`);
    return reply.send(JSON.stringify(data, null, 1));
  });
}

/** The exact names the seed uses, straight from the templates so they cannot drift. */
function sampleNames() {
  const foldersList: string[] = [];
  const companies: string[] = [];
  const offeringsList: string[] = [];
  for (const t of Object.values(TEMPLATES)) {
    for (const area of t.delivery) foldersList.push(area.name);
    for (const dl of t.deals) if (dl.company) companies.push(dl.company);
    for (const of2 of t.offerings) offeringsList.push(of2.name);
  }
  return {
    folders: [...new Set(foldersList)],
    companies: [...new Set(companies)],
    offerings: [...new Set(offeringsList)],
  };
}
