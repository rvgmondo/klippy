import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { CURRENCIES, isKnownCurrency } from '../lib/currency.js';
import { publicAccount } from '../lib/publicAccount.js';
import { businesses, businessMembers, businessEmail, memberships, users, teams, teamMembers, hostingSettings, paymentSettings } from '../db/schema.js';
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
}
