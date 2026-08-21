import type { FastifyInstance } from 'fastify';
import { money } from '../lib/money.js';
import { DEFAULT_CURRENCY, formatMoney, roundMoney } from '../lib/currency.js';
import { currencyFor } from '../lib/currencyFor.js';
import { z } from 'zod';
import { and, asc, desc, eq, gte, lt, lte, ne, isNotNull, isNull, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, businesses, folders, boards, tasks, timeEntries, payments, events } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { balanceOf, balancesFor } from '../lib/balances.js';
import { intId } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';
import { sendBusinessMail, emailBrandFor } from '../lib/mailer.js';
import { renderEmail, renderEmailText } from '../lib/emailLayout.js';
import { payLinkFor } from '../lib/paylink.js';
import { onInvoicePaid } from '../lib/hosting.js';
import { renderDocumentPdf } from '../lib/pdf.js';
import { businessScope, canSeeBusiness, assertMaybeBusiness } from '../lib/access.js';
import { nextNumberFor } from '../lib/numbering.js';
import { addDays } from '../lib/billing.js';
import { templateDataFor, fillTemplate } from '../lib/template.js';
import { buildStatement } from '../lib/statement.js';
import { quoteLinkFor } from './quotes.js';
import { renderStatementPdf } from '../lib/pdf.js';

const lineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  /** The longer version, printed under the title. Blank is the common case. */
  detail: z.string().trim().max(4000).nullable().optional(),
  quantity: z.number().nonnegative().max(1_000_000),
  unitPrice: z.number().max(100_000_000).min(-100_000_000),
  // What is being sold, and whether it repeats. Both optional: most lines are a
  // one-off bit of text and stay that way.
  offeringId: z.number().int().positive().nullable().optional(),
  recurringMonths: z.number().int().min(1).max(60).nullable().optional(),
});
const docType = z.enum(['quote', 'invoice']);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const bodySchema = z.object({
  /**
   * Present when this invoice was raised from tracked time. After the document
   * is created, every finished entry for that client in the range is stamped
   * with the invoice id, which is what turns "unbilled work" into a query.
   */
  fromTime: z.object({
    folderId: z.number().int().positive(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).optional(),
  type: docType,
  businessId: z.number().int().positive().optional(),
  folderId: z.number().int().positive().nullable().optional(),
  clientName: z.string().trim().min(1).max(150),
  clientEmail: z.string().trim().email().max(150).nullable().optional().or(z.literal('')),
  clientAddress: z.string().max(2000).nullable().optional(),
  clientVatNumber: z.string().trim().max(60).nullable().optional().or(z.literal('')),
  issueDate: dateStr,
  dueDate: dateStr.nullable().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  discountType: z.enum(['none', 'percent', 'amount']).optional(),
  discountValue: z.number().min(0).max(100_000_000).optional(),
  notes: z.string().max(5000).nullable().optional(),
  lines: z.array(lineSchema).max(200),
});

const PREFIX: Record<'quote' | 'invoice' | 'credit_note', string> = { quote: 'QUO-', invoice: 'INV-', credit_note: 'CN-' };

/**
 * Totals with an optional discount taken off the subtotal before tax, so tax is
 * charged on the discounted amount (the correct order for VAT).
 */
function computeTotals(
  lines: { quantity: number; unitPrice: number }[],
  taxRate: number, discountType: 'none' | 'percent' | 'amount' = 'none', discountValue = 0,
  currency = DEFAULT_CURRENCY,
) {
  // Every figure is rounded to what the currency can express, and each one is then
  // built from figures that are ALREADY rounded. Rounding each part independently
  // from the raw arithmetic gives an invoice that does not add up: a yen invoice
  // came out as 28,334 subtotal + 2,833 tax = 31,168, and a client checking the
  // column with a calculator gets 31,167. Rare at two decimals, routine at zero.
  const r = (n: number) => roundMoney(n, currency);

  // The unit price is rounded before it is multiplied, not after. Displaying a
  // rounded price beside an amount worked out from the unrounded one gives a row
  // that reads 2 x JPY 12,501 = JPY 25,001, which is simply wrong on its face.
  const priced = lines.map((l) => {
    const unitPrice = r(l.unitPrice);
    return { unitPrice, amount: r(l.quantity * unitPrice) };
  });
  const subtotal = r(priced.reduce((s, l) => s + l.amount, 0));

  let discountAmount = 0;
  if (discountType === 'percent') discountAmount = r(subtotal * (Math.min(discountValue, 100) / 100));
  else if (discountType === 'amount') discountAmount = r(Math.min(discountValue, subtotal));

  const taxable = r(subtotal - discountAmount);
  const taxAmount = r(taxable * (taxRate / 100));
  return { priced, subtotal, discountAmount, taxAmount, total: r(taxable + taxAmount) };
}

/**
 * What is still owed on an invoice: its total, less payments taken (a refund is a
 * negative payment) and less any credit notes raised against it. Credit notes are
 * the correct way to reduce an issued invoice, since an invoice that has gone to a
 * client should not be edited after the fact.
 */

// Numbering (prefix + where the count is) lives in lib/numbering.ts so every path
// that issues a document follows the same rule.
const nextNumber = nextNumberFor;

export async function documentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // List (summary), optionally filtered by type.
  app.get('/api/v1/documents', async (req) => {
    const { accountId } = authOf(req);
    const q = z.object({
      type: docType.optional(),
      businessId: z.coerce.number().int().positive().optional(),
    }).safeParse(req.query);
    const conds = [
      q.success && q.data.type ? eq(documents.type, q.data.type) : undefined,
      q.success && q.data.businessId ? eq(documents.businessId, q.data.businessId) : undefined,
      // A member only sees documents in businesses they can access.
      await businessScope(req, documents.businessId),
    ];
    const rows = await db.select({
      id: documents.id, type: documents.type, number: documents.number,
      clientName: documents.clientName, issueDate: documents.issueDate, dueDate: documents.dueDate,
      status: documents.status, currency: documents.currency, total: documents.total,
    }).from(documents)
      .where(tenantWhere(documents, accountId, ...conds))
      .orderBy(desc(documents.createdAt));
    return { documents: rows };
  });

  // Collections: unpaid invoices that are past due, worst first. Scoped to the
  // businesses the user can see. `suspended` marks the ones the schedule has already
  // sent a final notice for. This is the "who owes and needs chasing" screen.
  app.get('/api/v1/collections', async (req) => {
    const { accountId } = authOf(req);
    const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.select({
      id: documents.id, number: documents.number, clientName: documents.clientName,
      clientEmail: documents.clientEmail, businessId: documents.businessId,
      folderId: documents.folderId,
      currency: documents.currency, total: documents.total, dueDate: documents.dueDate,
      lastReminderOn: documents.lastReminderOn, suspendedAt: documents.suspendedAt,
    }).from(documents)
      .where(tenantWhere(documents, accountId,
        eq(documents.type, 'invoice'),
        eq(documents.status, 'sent'),          // unpaid; paid/void are settled
        isNotNull(documents.dueDate),
        lt(documents.dueDate, today),          // overdue only
        q.success && q.data.businessId ? eq(documents.businessId, q.data.businessId) : undefined,
        await businessScope(req, documents.businessId),
      ))
      .orderBy(asc(documents.dueDate));

    // Net off part payments and credit notes in two grouped queries rather than a
    // balance lookup per row, so this stays one screen's worth of work.
    const ids = rows.map((r) => r.id);
    const paidBy = new Map<number, number>();
    const creditedBy = new Map<number, number>();
    if (ids.length) {
      const payRows = await db.select({
        documentId: payments.documentId, amount: sql<string>`SUM(${payments.amount})`,
      }).from(payments)
        .where(tenantWhere(payments, accountId, inArray(payments.documentId, ids)))
        .groupBy(payments.documentId);
      for (const p of payRows) paidBy.set(p.documentId, Number(p.amount));
      const credRows = await db.select({
        sourceDocumentId: documents.sourceDocumentId, amount: sql<string>`SUM(${documents.total})`,
      }).from(documents)
        .where(tenantWhere(documents, accountId,
          eq(documents.type, 'credit_note'),
          inArray(documents.sourceDocumentId, ids),
          ne(documents.status, 'void')))
        .groupBy(documents.sourceDocumentId);
      for (const c of credRows) if (c.sourceDocumentId != null) creditedBy.set(c.sourceDocumentId, Number(c.amount));
    }

    const days = (d: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000);
    const round = (n: number) => Math.round(n * 100) / 100;
    const items = rows
      .map((r) => ({
        id: r.id, number: r.number, clientName: r.clientName, clientEmail: r.clientEmail,
        businessId: r.businessId, folderId: r.folderId, currency: r.currency, total: Number(r.total),
        // What is actually still owed, which is what you chase for.
        outstanding: round(Number(r.total) - (paidBy.get(r.id) ?? 0) - (creditedBy.get(r.id) ?? 0)),
        dueDate: r.dueDate, daysOverdue: r.dueDate ? days(r.dueDate) : 0,
        lastReminderOn: r.lastReminderOn, suspended: !!r.suspendedAt,
      }))
      // A fully credited or fully paid invoice is not a collections problem.
      .filter((i) => i.outstanding > 0.001);
    // One total PER CURRENCY. Adding a dollar invoice to a rand one produces a
    // number that is not money in any currency, and the old code did exactly that
    // and then labelled it with whatever the first row happened to be. Klippy does
    // not convert, so it reports each currency on its own line.
    const byCurrency = [...items.reduce((m, i) => {
      m.set(i.currency, (m.get(i.currency) ?? 0) + i.outstanding);
      return m;
    }, new Map<string, number>())]
      .map(([currency, outstanding]) => ({
        currency,
        outstanding: round(outstanding),
        count: items.filter((i) => i.currency === currency).length,
      }))
      .sort((a, b) => b.outstanding - a.outstanding);
    return {
      items,
      summary: {
        count: items.length,
        byCurrency,
        suspended: items.filter((i) => i.suspended).length,
      },
    };
  });

  /**
   * Chase everything owed, in one pass, grouped per client.
   *
   * Collections used to be one invoice at a time, and the manual email button sent
   * the STANDARD invoice email (not overdue-framed) without stamping
   * lastReminderOn, so the scheduler chased the same invoice again anyway. A client
   * owing three invoices got three separate wrongly-framed emails. This sends ONE
   * email per client per currency listing everything owed with a pay link each,
   * attaches their statement, and stamps every included invoice so the automated
   * reminders and this button stop talking over each other.
   */
  app.post('/api/v1/collections/chase', async (req, reply) => {
    const { accountId } = authOf(req);
    const parsed = z.object({
      ids: z.array(z.number().int().positive()).max(500).optional(),
      businessId: z.number().int().positive().optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.select({
      id: documents.id, number: documents.number, clientName: documents.clientName,
      clientEmail: documents.clientEmail, businessId: documents.businessId,
      folderId: documents.folderId, currency: documents.currency,
      total: documents.total, dueDate: documents.dueDate,
    }).from(documents)
      .where(tenantWhere(documents, accountId,
        eq(documents.type, 'invoice'),
        eq(documents.status, 'sent'),
        isNotNull(documents.dueDate),
        lt(documents.dueDate, today),
        parsed.data.ids?.length ? inArray(documents.id, parsed.data.ids) : undefined,
        parsed.data.businessId ? eq(documents.businessId, parsed.data.businessId) : undefined,
        await businessScope(req, documents.businessId),
      ));
    if (!rows.length) return { sent: 0, covered: 0, skipped: 0, detail: 'Nothing overdue matched.' };

    const balances = await balancesFor(accountId, rows);
    const owedRows = rows.filter((r) => (balances.get(r.id)?.outstanding ?? Number(r.total)) > 0.001);

    // One email per (client, currency). Grouped by folder when the invoice knows
    // its client record, otherwise by the email address on the invoice.
    const groups = new Map<string, typeof owedRows>();
    for (const r of owedRows) {
      if (!r.clientEmail) continue;
      const key = `${r.folderId ?? r.clientEmail}:${r.currency}`;
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    const skipped = owedRows.filter((r) => !r.clientEmail).length;

    let sent = 0;
    let covered = 0;
    for (const group of groups.values()) {
      const first = group[0]!;
      const owedTotal = group.reduce((s2, r) => s2 + (balances.get(r.id)?.outstanding ?? Number(r.total)), 0);
      const facts: [string, string][] = [];
      for (const r of group) {
        const owed = balances.get(r.id)?.outstanding ?? Number(r.total);
        facts.push([`${r.number} (was due ${r.dueDate})`, formatMoney(owed, r.currency)]);
      }
      facts.push(['Total owing', formatMoney(owedTotal, first.currency)]);

      // A pay link per invoice, each charging its own outstanding balance.
      const links: string[] = [];
      for (const r of group) {
        const link = await payLinkFor(accountId, r.id).catch(() => null);
        if (link) links.push(`Pay ${r.number}: ${link}`);
      }

      // Their statement rides along, so "what is this about?" answers itself.
      let attachment: { filename: string; content: Buffer } | undefined;
      if (first.folderId) {
        const st = await buildStatement(accountId, first.folderId, { currency: first.currency }).catch(() => null);
        if (st) {
          const pdf2 = await renderStatementPdf(accountId, st).catch(() => null);
          if (pdf2) attachment = { filename: pdf2.filename, content: pdf2.buffer };
        }
      }

      const emailBrand = await emailBrandFor(accountId, first.businessId);
      const content = {
        heading: group.length === 1
          ? `Invoice ${first.number} is overdue`
          : `${group.length} invoices are overdue`,
        body: [
          `Hi ${first.clientName},`,
          group.length === 1
            ? `Invoice ${first.number} has passed its due date and is still outstanding.`
            : 'The following invoices have passed their due dates and are still outstanding.',
          ...(links.length ? ['You can settle online:', ...links] : []),
          'If any of these have already been paid, please let us know so we can update our records.',
        ],
        facts,
      };
      try {
        await sendBusinessMail({
          accountId, businessId: first.businessId, purpose: 'invoice',
          to: first.clientEmail!,
          subject: content.heading,
          text: renderEmailText(emailBrand, content),
          html: renderEmail(emailBrand, content),
          attachments: attachment ? [attachment] : undefined,
        });
        await db.update(documents).set({ lastReminderOn: today })
          .where(tenantWhere(documents, accountId, inArray(documents.id, group.map((r) => r.id))));
        sent++;
        covered += group.length;
      } catch { /* one bad address must not stop the rest */ }
    }
    return { sent, covered, skipped };
  });

  /**
   * A client statement: every invoice, credit note and payment for one client over
   * a date range, oldest first, with a running balance. This is what you send when
   * someone asks "what do we actually owe you", and what you check before chasing.
   *
   * Entries are ordered by date, then by kind so that on a day where an invoice was
   * both raised and paid the charge lands before the payment and the balance reads
   * sensibly.
   */
  app.get('/api/v1/statements/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const folderId = intId(req);
    if (!folderId) return reply.code(400).send({ error: 'Bad id.' });
    const q = z.object({
      from: dateStr.optional(), to: dateStr.optional(),
      currency: z.string().trim().length(3).optional(),
    }).safeParse(req.query);
    const opts = q.success ? q.data : {};

    const [client] = await db.select({ id: folders.id, businessId: folders.businessId })
      .from(folders).where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
    if (!client) return reply.code(404).send({ error: 'Client not found.' });
    if (!(await assertMaybeBusiness(req, reply, client.businessId, 'viewer'))) return;

    const st = await buildStatement(accountId, folderId, opts);
    if (!st) return reply.code(404).send({ error: 'Client not found.' });
    return st;
  });

  /**
   * Email the statement to the client as a PDF, which is what "send me a statement"
   * actually means. It used to exist only on screen: month-end meant opening the
   * modal, printing to PDF, and emailing by hand, per client, per business.
   */
  app.post('/api/v1/statements/:id/email', async (req, reply) => {
    const { accountId } = authOf(req);
    const folderId = intId(req);
    if (!folderId) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      from: dateStr.optional(), to: dateStr.optional(),
      currency: z.string().trim().length(3).optional(),
      message: z.string().trim().max(2000).optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [client] = await db.select({ id: folders.id, businessId: folders.businessId, billingEmail: folders.billingEmail, name: folders.name })
      .from(folders).where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
    if (!client) return reply.code(404).send({ error: 'Client not found.' });
    if (!(await assertMaybeBusiness(req, reply, client.businessId))) return;
    if (!client.billingEmail) return reply.code(400).send({ error: 'This client has no billing email. Add one on the client first.' });

    const st = await buildStatement(accountId, folderId, parsed.data);
    if (!st) return reply.code(404).send({ error: 'Client not found.' });
    const pdf = await renderStatementPdf(accountId, st);

    const emailBrand = await emailBrandFor(accountId, client.businessId);
    const content = {
      heading: 'Your statement of account',
      body: [
        `Hi ${client.name},`,
        parsed.data.message?.trim() || 'Please find your statement of account attached.',
        `The balance owing is ${formatMoney(st.summary.balance, st.currency)}.`,
      ],
    };
    await sendBusinessMail({
      accountId, businessId: client.businessId, purpose: 'invoice',
      to: client.billingEmail,
      subject: `Statement of account: ${client.name}`,
      text: renderEmailText(emailBrand, content),
      html: renderEmail(emailBrand, content),
      attachments: [{ filename: pdf.filename, content: pdf.buffer }],
    });
    return { ok: true, to: client.billingEmail };
  });

  // The document as a PDF file, the same one that gets attached to its email.
  app.get('/api/v1/documents/:id/pdf', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [doc] = await db.select({ businessId: documents.businessId }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!doc) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, doc.businessId, 'viewer'))) return;
    const pdf = await renderDocumentPdf(accountId, id);
    if (!pdf) return reply.code(404).send({ error: 'Not found.' });
    // ?inline=1 previews it in the browser instead of downloading.
    const inline = (req.query as { inline?: string })?.inline === '1';
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${pdf.filename}"`)
      .send(pdf.buffer);
  });

  // One document with its line items.
  app.get('/api/v1/documents/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [doc] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!doc || (doc.businessId && !(await canSeeBusiness(req, doc.businessId)))) {
      return reply.code(404).send({ error: 'Not found.' });
    }
    const lines = await db.select().from(documentLines)
      .where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, id)))
      .orderBy(documentLines.position);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    // The document is branded from ITS business, not the whole account. Each of the
    // business's fields falls back to the account only when the business has not set
    // it, so nothing looks emptier than it did before per-business identity existed.
    const [business] = doc.businessId
      ? await db.select().from(businesses).where(tenantWhere(businesses, accountId, eq(businesses.id, doc.businessId))).limit(1)
      : [undefined];
    const pick = <K extends 'bizAddress' | 'bizTaxNumber' | 'bizRegNumber' | 'bankDetails' | 'invoiceFooter'>(k: K) =>
      (business?.[k] ?? account?.[k] ?? null);
    const name = business?.brandName || business?.name || account?.brandName || 'Klippy';
    const logoUrl = business?.logoPath ? `/api/v1/businesses/${business.id}/logo`
      : account?.logoPath ? '/api/v1/account/logo' : null;
    return {
      document: doc, lines,
      brand: { name, hasLogo: !!logoUrl, logoUrl },
      // The "from" side of the document, so the template can render a real letterhead.
      issuer: {
        name,
        logoUrl,
        address: pick('bizAddress'),
        taxNumber: pick('bizTaxNumber'),
        regNumber: pick('bizRegNumber'),
        bankDetails: pick('bankDetails'),
        footer: pick('invoiceFooter'),
        accent: business?.invoiceAccent || account?.invoiceAccent || '#6366f1',
        // A VAT-registered issuer's invoices are "Tax Invoices" (SARS wording).
        vatRegistered: !!pick('bizTaxNumber'),
        // The business's own typefaces, so its invoice looks like its brand.
        fontDisplay: business?.fontDisplay ?? null,
        fontBody: business?.fontBody ?? null,
        // Custom blocks, already sanitised on save and now with the placeholders
        // filled. Resolved HERE so the screen and the PDF render the same words.
        headerHtml: business?.invoiceHeaderHtml
          ? fillTemplate(business.invoiceHeaderHtml, templateDataFor(doc, business, account)) : null,
        footerHtml: business?.invoiceFooterHtml
          ? fillTemplate(business.invoiceFooterHtml, templateDataFor(doc, business, account)) : null,
      },
    };
  });

  app.post('/api/v1/documents', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const businessId = await resolveBusinessId(accountId, d.businessId);
    // The business decides what it bills in, so this has to be settled before the
    // totals: rounding depends on the currency. Copied onto the document and never
    // re-read, so changing the setting later cannot restate what was already issued.
    const currency = await currencyFor(accountId, businessId);

    const taxRate = d.taxRate ?? 0;
    const discountType = d.discountType ?? 'none';
    const discountValue = d.discountValue ?? 0;
    const totals = computeTotals(d.lines, taxRate, discountType, discountValue, currency);

    // A member can only raise a document in a business they can work in.
    if (businessId && !(await canSeeBusiness(req, businessId))) {
      return reply.code(403).send({ error: 'You do not have access to that business.' });
    }
    // Numbering is per business + type.
    const { seq, number } = await nextNumber(accountId, businessId, d.type);
    const docId = await db.transaction(async (tx) => {
      const ins = await tx.insert(documents).values(withTenant(accountId, {
        type: d.type, seq, number, businessId, folderId: d.folderId ?? null,
        clientName: d.clientName, clientEmail: d.clientEmail || null, clientAddress: d.clientAddress ?? null,
        clientVatNumber: d.clientVatNumber || null,
        issueDate: d.issueDate, dueDate: d.dueDate ?? null, currency,
        discountType, discountValue: money(discountValue), discountAmount: money(totals.discountAmount),
        taxRate: money(taxRate), subtotal: money(totals.subtotal),
        taxAmount: money(totals.taxAmount), total: money(totals.total),
        notes: d.notes ?? null, createdBy: userId,
      }));
      const newId = Number(ins[0].insertId);
      if (d.lines.length) {
        await tx.insert(documentLines).values(d.lines.map((l, i) => withTenant(accountId, {
          documentId: newId, description: l.description, detail: l.detail || null,
          quantity: money(l.quantity),
          unitPrice: money(totals.priced[i]?.unitPrice ?? 0),
          amount: money(totals.priced[i]?.amount ?? 0), position: i,
          offeringId: l.offeringId ?? null, recurringMonths: l.recurringMonths ?? null,
        })));
      }
      return newId;
    });

    if (d.type === 'invoice' && d.fromTime) {
      const { folderId: ftFolder, from: ftFrom, to: ftTo } = d.fromTime;
      // The same subtree walk the from-time preview used, so the stamped set is
      // exactly the set that was billed.
      const allFolders2 = await db.select({ id: folders.id, parentId: folders.parentId })
        .from(folders).where(tenantWhere(folders, accountId));
      const subtree2 = new Set<number>([ftFolder]);
      let grew2 = true;
      while (grew2) {
        grew2 = false;
        for (const f of allFolders2) {
          if (f.parentId != null && subtree2.has(f.parentId) && !subtree2.has(f.id)) { subtree2.add(f.id); grew2 = true; }
        }
      }
      const boardIds = (await db.select({ id: boards.id }).from(boards)
        .where(tenantWhere(boards, accountId, inArray(boards.folderId, [...subtree2])))).map((b) => b.id);
      if (boardIds.length) {
        await db.update(timeEntries).set({ billedDocumentId: docId })
          .where(tenantWhere(timeEntries, accountId, and(
            isNotNull(timeEntries.durationSeconds),
            isNull(timeEntries.billedDocumentId),
            sql`${timeEntries.taskId} IN (SELECT id FROM tasks WHERE board_id IN (${sql.join(boardIds.map((b) => sql`${b}`), sql`, `)}))`,
            gte(timeEntries.startTime, new Date(`${ftFrom}T00:00:00.000Z`)),
            lte(timeEntries.startTime, new Date(`${ftTo}T23:59:59.999Z`)),
          )));
      }
    }
    const [created] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, docId))).limit(1);
    return reply.code(201).send({ document: created });
  });

  // Replace the whole document (fields + lines).
  app.put('/api/v1/documents/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const [existing] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, existing.businessId))) return;

    const taxRate = d.taxRate ?? 0;
    const discountType = d.discountType ?? 'none';
    const discountValue = d.discountValue ?? 0;
    // The document's own currency, not the business's current setting: editing an
    // old invoice must not silently re-round it into whatever the business bills in
    // today.
    const totals = computeTotals(d.lines, taxRate, discountType, discountValue, existing.currency);
    await db.transaction(async (tx) => {
      await tx.update(documents).set({
        folderId: d.folderId ?? null, clientName: d.clientName, clientEmail: d.clientEmail || null,
        clientAddress: d.clientAddress ?? null, clientVatNumber: d.clientVatNumber || null,
        issueDate: d.issueDate, dueDate: d.dueDate ?? null,
        discountType, discountValue: money(discountValue), discountAmount: money(totals.discountAmount),
        taxRate: money(taxRate), subtotal: money(totals.subtotal),
        taxAmount: money(totals.taxAmount), total: money(totals.total), notes: d.notes ?? null,
      }).where(tenantWhere(documents, accountId, eq(documents.id, id)));
      await tx.delete(documentLines).where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, id)));
      if (d.lines.length) {
        await tx.insert(documentLines).values(d.lines.map((l, i) => withTenant(accountId, {
          documentId: id, description: l.description, detail: l.detail || null,
          quantity: money(l.quantity),
          unitPrice: money(totals.priced[i]?.unitPrice ?? 0),
          amount: money(totals.priced[i]?.amount ?? 0), position: i,
          offeringId: l.offeringId ?? null, recurringMonths: l.recurringMonths ?? null,
        })));
      }
    });
    const [updated] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    return { document: updated };
  });

  // Change just the status (draft -> sent -> paid, etc).
  app.patch('/api/v1/documents/:id/status', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({ status: z.enum(['draft', 'sent', 'accepted', 'paid', 'void']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Bad status.' });
    const [own] = await db.select({ businessId: documents.businessId }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    const res = await db.update(documents).set({ status: parsed.data.status })
      .where(tenantWhere(documents, accountId, eq(documents.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
    return { ok: true };
  });

  app.delete('/api/v1/documents/:id', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [own] = await db.select({
      businessId: documents.businessId, type: documents.type, number: documents.number,
      status: documents.status, total: documents.total,
    }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;

    // A draft was never issued to anyone, so it can be deleted outright. Anything
    // that has been sent, accepted or paid is a real document a client may hold and,
    // for a tax invoice, part of the sequential numbering SARS requires to be
    // gap-free. Those are VOIDED, not deleted: the row and its number stay, marked
    // void so they drop out of balances and collections. Either way it is recorded.
    const issued = own.status !== 'draft';
    if (issued) {
      if (own.status === 'void') return { ok: true, voided: true };
      await db.update(documents).set({ status: 'void' })
        .where(tenantWhere(documents, accountId, eq(documents.id, id)));
    } else {
      await db.delete(documents).where(tenantWhere(documents, accountId, eq(documents.id, id)));
    }
    await db.insert(events).values({
      accountId, businessId: own.businessId, name: issued ? 'document.voided' : 'document.deleted',
      payload: { documentId: id, number: own.number, type: own.type, total: own.total, was: own.status },
      results: [{ handler: 'documents', outcome: `${issued ? 'Voided' : 'Deleted'} ${own.number} by user ${userId}`, ok: true }],
    }).catch(() => { /* audit is best-effort; never block the action on it */ });
    return { ok: true, voided: issued };
  });

  // Turn an accepted quote into a fresh invoice (copies client + lines).
  app.post('/api/v1/documents/:id/convert', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [quote] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, and(eq(documents.id, id), eq(documents.type, 'quote')))).limit(1);
    if (!quote) return reply.code(404).send({ error: 'Quote not found.' });
    if (!(await assertMaybeBusiness(req, reply, quote.businessId))) return;
    const lines = await db.select().from(documentLines)
      .where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, id))).orderBy(documentLines.position);

    const { seq, number } = await nextNumber(accountId, quote.businessId, 'invoice');
    const today = new Date().toISOString().slice(0, 10);
    // A quote-born invoice used to have NO due date, so it never appeared on
    // Collections, never triggered a reminder, and never counted toward hosting
    // suspension. Give it the business's standard term (fallback 14 days) so the
    // most common invoice source is actually chased.
    const dueDays = await (async () => {
      if (!quote.businessId) return 14;
      const [b] = await db.select({ d: businesses.defaultDueDays }).from(businesses)
        .where(tenantWhere(businesses, accountId, eq(businesses.id, quote.businessId))).limit(1);
      return b?.d ?? 14;
    })();
    const dueDate = addDays(today, dueDays);

    const newId = await db.transaction(async (tx) => {
      const ins = await tx.insert(documents).values(withTenant(accountId, {
        type: 'invoice' as const, seq, number, businessId: quote.businessId, folderId: quote.folderId,
        clientName: quote.clientName, clientEmail: quote.clientEmail, clientAddress: quote.clientAddress,
        clientVatNumber: quote.clientVatNumber,
        issueDate: today, dueDate, currency: quote.currency, taxRate: quote.taxRate,
        discountType: quote.discountType, discountValue: quote.discountValue, discountAmount: quote.discountAmount,
        subtotal: quote.subtotal, taxAmount: quote.taxAmount, total: quote.total,
        notes: quote.notes, createdBy: userId,
      }));
      const iid = Number(ins[0].insertId);
      if (lines.length) {
        await tx.insert(documentLines).values(lines.map((l, i) => withTenant(accountId, {
          documentId: iid, description: l.description, detail: l.detail,
          quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, position: i,
        })));
      }
      return iid;
    });
    await db.update(documents).set({ status: 'accepted' })
      .where(tenantWhere(documents, accountId, eq(documents.id, id)));
    const [created] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, newId))).limit(1);
    return reply.code(201).send({ document: created });
  });

  /**
   * Raise a credit note against an invoice.
   *
   * An invoice that has gone to a client should not be quietly edited, so this is
   * how you cancel or reduce one and keep an audit trail. With no lines it credits
   * the whole invoice; with lines it credits part of it. The credit reduces what is
   * owed, and settles the invoice outright when nothing is left.
   */
  app.post('/api/v1/documents/:id/credit-note', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      lines: z.array(lineSchema).max(200).optional(),
      reason: z.string().trim().max(2000).optional(),
      issueDate: dateStr.optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [inv] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, and(eq(documents.id, id), eq(documents.type, 'invoice')))).limit(1);
    if (!inv) return reply.code(404).send({ error: 'Invoice not found.' });
    if (!(await assertMaybeBusiness(req, reply, inv.businessId))) return;

    const taxRate = Number(inv.taxRate);
    const bal = await balanceOf(accountId, id, Number(inv.total));
    if (bal.outstanding <= 0.001) return reply.code(400).send({ error: 'Nothing left to credit on this invoice.' });

    // With no lines given, credit exactly what is still outstanding. The balance is
    // tax-inclusive, so we work backwards to a net amount and let the same tax rate
    // put it back, which keeps the credit note's VAT correct.
    const lines = parsed.data.lines?.length
      ? parsed.data.lines
      : [{
          description: `Credit against invoice ${inv.number}`,
          quantity: 1,
          unitPrice: roundMoney(bal.outstanding / (1 + taxRate / 100), inv.currency),
        }];

    const totals = computeTotals(lines, taxRate, 'none', 0, inv.currency);
    if (totals.total > bal.outstanding + 0.02) {
      return reply.code(400).send({
        error: `That credits ${formatMoney(totals.total, inv.currency)} but only ${formatMoney(bal.outstanding, inv.currency)} is outstanding.`,
      });
    }

    const { seq, number } = await nextNumber(accountId, inv.businessId, 'credit_note');
    const issueDate = parsed.data.issueDate ?? new Date().toISOString().slice(0, 10);

    const newId = await db.transaction(async (tx) => {
      const ins = await tx.insert(documents).values(withTenant(accountId, {
        type: 'credit_note' as const, seq, number, businessId: inv.businessId,
        sourceDocumentId: inv.id, folderId: inv.folderId,
        clientName: inv.clientName, clientEmail: inv.clientEmail, clientAddress: inv.clientAddress,
        clientVatNumber: inv.clientVatNumber,
        issueDate, dueDate: null, currency: inv.currency, status: 'sent' as const,
        taxRate: inv.taxRate, subtotal: money(totals.subtotal),
        taxAmount: money(totals.taxAmount), total: money(totals.total),
        notes: parsed.data.reason ?? `Credit against invoice ${inv.number}.`, createdBy: userId,
      }));
      const cid = Number(ins[0].insertId);
      await tx.insert(documentLines).values(lines.map((l, i) => withTenant(accountId, {
        documentId: cid, description: l.description, detail: l.detail,
        quantity: money(l.quantity),
        unitPrice: money(totals.priced[i]?.unitPrice ?? 0),
        amount: money(totals.priced[i]?.amount ?? 0), position: i,
      })));
      return cid;
    });

    // Settle the invoice if the credit clears whatever was left.
    const after = await balanceOf(accountId, id, Number(inv.total));
    if (after.outstanding <= 0.001 && inv.status !== 'paid') {
      await db.update(documents).set({ status: 'paid' })
        .where(tenantWhere(documents, accountId, eq(documents.id, id)));
    }

    const [created] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, newId))).limit(1);
    return reply.code(201).send({ document: created, invoiceBalance: after });
  });

  // ---- Payments -----------------------------------------------------------
  // List payments + outstanding balance for a document.
  app.get('/api/v1/documents/:id/payments', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [doc] = await db.select({ total: documents.total, businessId: documents.businessId }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!doc) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, doc.businessId, 'viewer'))) return;
    const rows = await db.select().from(payments)
      .where(tenantWhere(payments, accountId, eq(payments.documentId, id))).orderBy(payments.paidOn);
    const total = Number(doc.total);
    const bal = await balanceOf(accountId, id, total);
    // Credit notes raised against this invoice, so the drawer can show why the
    // balance is lower than the total without the user hunting for them.
    const credits = await db.select({
      id: documents.id, number: documents.number, total: documents.total,
      issueDate: documents.issueDate, notes: documents.notes,
    }).from(documents)
      .where(tenantWhere(documents, accountId,
        eq(documents.type, 'credit_note'), eq(documents.sourceDocumentId, id), ne(documents.status, 'void')))
      .orderBy(documents.issueDate);
    return { payments: rows, credits, total, ...bal };
  });

  app.post('/api/v1/documents/:id/payments', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      // Negative records a REFUND against this invoice, which is why this is not
      // simply .positive(). Zero would be a no-op, so it stays excluded.
      amount: z.number().refine((n) => n !== 0, 'Amount cannot be zero.')
        .refine((n) => Math.abs(n) <= 100_000_000, 'Amount is too large.'),
      paidOn: dateStr,
      method: z.string().trim().max(40).nullable().optional(),
      note: z.string().trim().max(255).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [doc] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!doc) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, doc.businessId))) return;

    await db.insert(payments).values(withTenant(accountId, {
      documentId: id, amount: money(parsed.data.amount), paidOn: parsed.data.paidOn,
      method: parsed.data.method ?? null, note: parsed.data.note ?? null, createdBy: userId,
    }));
    // Auto-flip to paid once nothing is outstanding, and back to sent if a refund
    // re-opens a balance on an invoice that had been settled.
    const bal = await balanceOf(accountId, id, Number(doc.total));
    const settled = bal.outstanding <= 0.001;
    if (settled && doc.status !== 'paid') {
      await db.update(documents).set({ status: 'paid' })
        .where(tenantWhere(documents, accountId, eq(documents.id, id)));
      await onInvoicePaid(accountId, id);
    } else if (!settled && doc.status === 'paid' && parsed.data.amount >= 0) {
      // Only a genuine reopening (a correcting entry, not a refund) reverts to
      // 'sent'. A refund is money you GAVE BACK: flipping the invoice back to 'sent'
      // used to re-enter it into the reminder + auto-suspend pipeline and chase, or
      // switch off the site of, a client you just refunded.
      await db.update(documents).set({ status: 'sent' })
        .where(tenantWhere(documents, accountId, eq(documents.id, id)));
    }
    return reply.code(201).send({ ok: true, ...bal });
  });

  app.delete('/api/v1/payments/:id', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    // Record what is being removed BEFORE removing it, so deleting money always
    // leaves a trace of who did it and how much. Payments are legitimately corrected,
    // so this stays a real delete, but never a silent one.
    const [pay] = await db.select({
      amount: payments.amount, documentId: payments.documentId, method: payments.method,
    }).from(payments).where(tenantWhere(payments, accountId, eq(payments.id, id))).limit(1);
    const res = await db.delete(payments).where(tenantWhere(payments, accountId, eq(payments.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
    if (pay) {
      await db.insert(events).values({
        accountId, businessId: null, name: 'payment.deleted',
        payload: { paymentId: id, documentId: pay.documentId, amount: pay.amount, method: pay.method },
        results: [{ handler: 'payments', outcome: `Deleted payment ${pay.amount} on doc ${pay.documentId} by user ${userId}`, ok: true }],
      }).catch(() => {});
    }
    return { ok: true };
  });

  // ---- Email the document to the client -----------------------------------
  app.post('/api/v1/documents/:id/email', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({ to: z.string().trim().email().optional(), message: z.string().max(2000).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Bad email address.' });

    const [doc] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!doc) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, doc.businessId))) return;
    const to = parsed.data.to || doc.clientEmail;
    if (!to) return reply.code(400).send({ error: 'No client email on this document. Add one or pass "to".' });

    const lines = await db.select().from(documentLines)
      .where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, id))).orderBy(documentLines.position);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    // Sign the email as the document's business, not the account.
    const [business] = doc.businessId
      ? await db.select({ brandName: businesses.brandName, name: businesses.name }).from(businesses)
        .where(tenantWhere(businesses, accountId, eq(businesses.id, doc.businessId))).limit(1)
      : [undefined];
    const brand = business?.brandName || business?.name || account?.brandName || 'Klippy';
    const fmt = (v: string | number) => formatMoney(v, doc.currency);

    const lineText = lines.map((l) => {
      const head = `  - ${l.description}: ${Number(l.quantity)} x ${fmt(l.unitPrice)} = ${fmt(l.amount)}`;
      // Indented under its own line, so the plain-text copy of the email says
      // as much as the PDF attached to it.
      if (!l.detail) return head;
      const wrapped = l.detail.split('\n').map((x) => `      ${x}`).join('\n');
      return `${head}\n${wrapped}`;
    }).join('\n');
    const label = doc.type === 'quote' ? 'Quotation' : 'Invoice';
    // A one-click way to pay, when PayFast is on. Invoices only, never quotes.
    const payLink = doc.type === 'invoice' && doc.status !== 'paid'
      ? await payLinkFor(accountId, doc.id) : null;
    // A quote instead carries its accept link: the client can say yes from the
    // email itself, name recorded, no account needed.
    const acceptLink = doc.type === 'quote' && !doc.decision ? quoteLinkFor(doc.id) : null;
    // One branded layout for every send, with its plain-text twin alongside.
    const emailBrand = await emailBrandFor(accountId, doc.businessId);
    const content = {
      heading: `${label} ${doc.number}`,
      body: [
        `Hi ${doc.clientName},`,
        parsed.data.message?.trim()
          || `Please find ${doc.type} ${doc.number} below. The full document is attached as a PDF.`,
      ],
      facts: [
        ['Issued', doc.issueDate] as [string, string],
        ...(doc.dueDate ? [[doc.type === 'quote' ? 'Valid until' : 'Due', doc.dueDate] as [string, string]] : []),
        ['Subtotal', fmt(doc.subtotal)] as [string, string],
        ...(Number(doc.taxRate) > 0
          ? [[`Tax (${Number(doc.taxRate)}%)`, fmt(doc.taxAmount)] as [string, string]] : []),
        ['Total', fmt(doc.total)] as [string, string],
      ],
      ...(payLink ? { button: { label: 'Pay online', url: payLink } } : {}),
      ...(acceptLink ? { button: { label: 'View and accept this quote', url: acceptLink } } : {}),
      ...(doc.notes?.trim() ? { note: doc.notes.trim() } : {}),
    };
    const html = renderEmail(emailBrand, content);
    // The text twin also carries the line items, which the HTML leaves to the PDF.
    const body = `${renderEmailText(emailBrand, content)}\n\nItems:\n${lineText}`;

    try {
      // Attach the document itself. A failed render must not stop the email, so a
      // client still gets the details in the body either way.
      const pdf = await renderDocumentPdf(accountId, doc.id).catch((err) => {
        req.log.error({ err, docId: doc.id }, 'invoice pdf render failed, sending without it');
        return null;
      });
      await sendBusinessMail({
        accountId, businessId: doc.businessId, purpose: 'invoice',
        to, subject: `${label} ${doc.number} from ${brand}`, text: body, html,
        attachments: pdf ? [{ filename: pdf.filename, content: pdf.buffer }] : undefined,
      });
    } catch (err) {
      req.log.error({ err }, 'document email failed');
      return reply.code(502).send({ error: 'Could not send the email. Check the mail settings.' });
    }
    if (doc.status === 'draft') {
      await db.update(documents).set({ status: 'sent' }).where(tenantWhere(documents, accountId, eq(documents.id, id)));
    }
    return { ok: true, to };
  });

  // Suggest invoice lines from tracked time for a client folder in a date range.
  // One line per board that had time logged, quantity = hours, unit = the
  // client's inherited hourly rate. Ready to drop straight into a new invoice.
  app.get('/api/v1/documents/from-time', async (req, reply) => {
    const { accountId } = authOf(req);
    const q = z.object({
      folderId: z.coerce.number().int().positive(),
      from: dateStr, to: dateStr,
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'folderId, from, to required.' });

    const allFolders = await db.select({
      id: folders.id, parentId: folders.parentId, name: folders.name, hourlyRate: folders.hourlyRate,
    }).from(folders).where(tenantWhere(folders, accountId));
    const byId = new Map(allFolders.map((f) => [f.id, f]));
    const client = byId.get(q.data.folderId);
    if (!client) return reply.code(404).send({ error: 'Client not found.' });

    // Rate inherited from the nearest ancestor that sets one.
    let rate = 0;
    for (let cur = client, i = 0; cur && i < 100; i++) {
      if (cur.hourlyRate != null) { rate = Number(cur.hourlyRate); break; }
      if (cur.parentId == null) break;
      cur = byId.get(cur.parentId)!;
    }

    // All folders in this client's subtree (itself + descendants).
    const subtree = new Set<number>([client.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of allFolders) {
        if (f.parentId != null && subtree.has(f.parentId) && !subtree.has(f.id)) { subtree.add(f.id); grew = true; }
      }
    }

    const boardRows = await db.select({ id: boards.id, name: boards.name }).from(boards)
      .where(tenantWhere(boards, accountId, inArray(boards.folderId, [...subtree])));
    if (boardRows.length === 0) return { clientName: client.name, rate, lines: [], totalHours: 0 };
    const boardName = new Map(boardRows.map((b) => [b.id, b.name]));

    const start = new Date(`${q.data.from}T00:00:00.000Z`);
    const end = new Date(`${q.data.to}T23:59:59.999Z`);
    const rows = await db.select({
      boardId: tasks.boardId,
      seconds: sql<number>`COALESCE(SUM(${timeEntries.durationSeconds}),0)`,
    }).from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(tenantWhere(timeEntries, accountId, and(
        isNotNull(timeEntries.durationSeconds),
        inArray(tasks.boardId, boardRows.map((b) => b.id)),
        gte(timeEntries.startTime, start),
        lte(timeEntries.startTime, end),
      )))
      .groupBy(tasks.boardId);

    let totalHours = 0;
    const lines = rows
      .map((r) => {
        const hours = Math.round((Number(r.seconds) / 3600) * 100) / 100;
        totalHours += hours;
        return {
          description: `${boardName.get(r.boardId) ?? 'Work'} (${q.data.from} to ${q.data.to})`,
          quantity: hours,
          unitPrice: rate,
        };
      })
      .filter((l) => l.quantity > 0)
      .sort((a, b) => b.quantity - a.quantity);

    return { clientName: client.name, rate, totalHours: Math.round(totalHours * 100) / 100, lines };
  });
}
