import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, gte, lt, lte, ne, isNotNull, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, businesses, folders, boards, tasks, timeEntries, payments } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { resolveBusinessId } from '../lib/business.js';
import { sendBusinessMail, emailBrandFor } from '../lib/mailer.js';
import { renderEmail, renderEmailText } from '../lib/emailLayout.js';
import { payLinkFor } from '../lib/paylink.js';
import { onInvoicePaid } from '../lib/hosting.js';
import { renderDocumentPdf } from '../lib/pdf.js';
import { businessScope, canSeeBusiness, assertMaybeBusiness } from '../lib/access.js';
import { nextNumberFor } from '../lib/numbering.js';
import { templateDataFor, fillTemplate } from '../lib/template.js';

const lineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().nonnegative().max(1_000_000),
  unitPrice: z.number().max(100_000_000).min(-100_000_000),
});
const docType = z.enum(['quote', 'invoice']);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const bodySchema = z.object({
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
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * Totals with an optional discount taken off the subtotal before tax, so tax is
 * charged on the discounted amount (the correct order for VAT).
 */
function computeTotals(
  lines: { quantity: number; unitPrice: number }[],
  taxRate: number, discountType: 'none' | 'percent' | 'amount' = 'none', discountValue = 0,
) {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  let discountAmount = 0;
  if (discountType === 'percent') discountAmount = subtotal * (Math.min(discountValue, 100) / 100);
  else if (discountType === 'amount') discountAmount = Math.min(discountValue, subtotal);
  const taxable = subtotal - discountAmount;
  const taxAmount = taxable * (taxRate / 100);
  return { subtotal, discountAmount, taxAmount, total: taxable + taxAmount };
}

/**
 * What is still owed on an invoice: its total, less payments taken (a refund is a
 * negative payment) and less any credit notes raised against it. Credit notes are
 * the correct way to reduce an issued invoice, since an invoice that has gone to a
 * client should not be edited after the fact.
 */
async function balanceOf(accountId: number, docId: number, total: number) {
  const payRows = await db.select({ amount: payments.amount }).from(payments)
    .where(tenantWhere(payments, accountId, eq(payments.documentId, docId)));
  const paid = payRows.reduce((s, p) => s + Number(p.amount), 0);
  const creditRows = await db.select({ total: documents.total }).from(documents)
    .where(tenantWhere(documents, accountId,
      eq(documents.type, 'credit_note'),
      eq(documents.sourceDocumentId, docId),
      ne(documents.status, 'void'),
    ));
  const credited = creditRows.reduce((s, c) => s + Number(c.total), 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { paid: round(paid), credited: round(credited), outstanding: round(total - paid - credited) };
}

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
    const outstanding = round(items.reduce((s, i) => s + i.outstanding, 0));
    return {
      items,
      summary: { count: items.length, outstanding, suspended: items.filter((i) => i.suspended).length },
    };
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
    const q = z.object({ from: dateStr.optional(), to: dateStr.optional() }).safeParse(req.query);
    const from = q.success ? q.data.from : undefined;
    const to = q.success ? q.data.to : undefined;

    const [client] = await db.select({ id: folders.id, name: folders.name, businessId: folders.businessId })
      .from(folders).where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
    if (!client) return reply.code(404).send({ error: 'Client not found.' });
    if (!(await assertMaybeBusiness(req, reply, client.businessId, 'viewer'))) return;

    const docs = await db.select({
      id: documents.id, type: documents.type, number: documents.number, issueDate: documents.issueDate,
      dueDate: documents.dueDate, total: documents.total, status: documents.status, currency: documents.currency,
    }).from(documents)
      .where(tenantWhere(documents, accountId,
        eq(documents.folderId, folderId),
        inArray(documents.type, ['invoice', 'credit_note']),
        ne(documents.status, 'void'),
        ne(documents.status, 'draft'),      // a draft has not been issued to anyone
        from ? gte(documents.issueDate, from) : undefined,
        to ? lte(documents.issueDate, to) : undefined,
      ));

    // Payments belong to those documents, so pull them by document id.
    const docIds = docs.map((d) => d.id);
    const payRows = docIds.length
      ? await db.select({
          id: payments.id, documentId: payments.documentId, amount: payments.amount,
          paidOn: payments.paidOn, method: payments.method,
        }).from(payments)
          .where(tenantWhere(payments, accountId,
            inArray(payments.documentId, docIds),
            from ? gte(payments.paidOn, from) : undefined,
            to ? lte(payments.paidOn, to) : undefined,
          ))
      : [];
    const numberOf = new Map(docs.map((d) => [d.id, d.number]));

    type Entry = { date: string; kind: 'invoice' | 'credit_note' | 'payment' | 'refund'; ref: string; detail: string | null; charge: number; credit: number };
    const entries: Entry[] = [
      ...docs.map((d): Entry => d.type === 'invoice'
        ? { date: d.issueDate, kind: 'invoice', ref: d.number, detail: d.dueDate ? `due ${d.dueDate}` : null, charge: Number(d.total), credit: 0 }
        : { date: d.issueDate, kind: 'credit_note', ref: d.number, detail: 'credit note', charge: 0, credit: Number(d.total) }),
      ...payRows.map((p): Entry => {
        const amt = Number(p.amount);
        const against = numberOf.get(p.documentId) ?? '';
        return amt < 0
          ? { date: p.paidOn, kind: 'refund', ref: against, detail: `refund${p.method ? ` (${p.method})` : ''}`, charge: -amt, credit: 0 }
          : { date: p.paidOn, kind: 'payment', ref: against, detail: `payment${p.method ? ` (${p.method})` : ''}`, charge: 0, credit: amt };
      }),
    ];
    // Charges before credits on the same day, so the running balance reads right.
    const rank = { invoice: 0, refund: 1, credit_note: 2, payment: 3 };
    entries.sort((a, b) => a.date.localeCompare(b.date) || rank[a.kind] - rank[b.kind]);

    const round = (n: number) => Math.round(n * 100) / 100;
    let balance = 0;
    const rows = entries.map((e) => {
      balance = round(balance + e.charge - e.credit);
      return { ...e, charge: round(e.charge), credit: round(e.credit), balance };
    });

    return {
      client: { id: client.id, name: client.name, businessId: client.businessId },
      from: from ?? null, to: to ?? null,
      currency: docs[0]?.currency ?? 'ZAR',
      entries: rows,
      summary: {
        invoiced: round(entries.reduce((s, e) => s + (e.kind === 'invoice' ? e.charge : 0), 0)),
        credited: round(entries.reduce((s, e) => s + (e.kind === 'credit_note' ? e.credit : 0), 0)),
        received: round(entries.reduce((s, e) => s + (e.kind === 'payment' ? e.credit : 0) - (e.kind === 'refund' ? e.charge : 0), 0)),
        balance: round(balance),
      },
    };
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

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const currency = account?.currency ?? 'ZAR';
    const taxRate = d.taxRate ?? 0;
    const discountType = d.discountType ?? 'none';
    const discountValue = d.discountValue ?? 0;
    const totals = computeTotals(d.lines, taxRate, discountType, discountValue);

    const businessId = await resolveBusinessId(accountId, d.businessId);
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
          documentId: newId, description: l.description, quantity: money(l.quantity),
          unitPrice: money(l.unitPrice), amount: money(l.quantity * l.unitPrice), position: i,
        })));
      }
      return newId;
    });
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
    const totals = computeTotals(d.lines, taxRate, discountType, discountValue);
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
          documentId: id, description: l.description, quantity: money(l.quantity),
          unitPrice: money(l.unitPrice), amount: money(l.quantity * l.unitPrice), position: i,
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
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [own] = await db.select({ businessId: documents.businessId }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!own) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;
    const res = await db.delete(documents).where(tenantWhere(documents, accountId, eq(documents.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
    return { ok: true };
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

    const newId = await db.transaction(async (tx) => {
      const ins = await tx.insert(documents).values(withTenant(accountId, {
        type: 'invoice' as const, seq, number, businessId: quote.businessId, folderId: quote.folderId,
        clientName: quote.clientName, clientEmail: quote.clientEmail, clientAddress: quote.clientAddress,
        clientVatNumber: quote.clientVatNumber,
        issueDate: today, dueDate: null, currency: quote.currency, taxRate: quote.taxRate,
        discountType: quote.discountType, discountValue: quote.discountValue, discountAmount: quote.discountAmount,
        subtotal: quote.subtotal, taxAmount: quote.taxAmount, total: quote.total,
        notes: quote.notes, createdBy: userId,
      }));
      const iid = Number(ins[0].insertId);
      if (lines.length) {
        await tx.insert(documentLines).values(lines.map((l, i) => withTenant(accountId, {
          documentId: iid, description: l.description, quantity: l.quantity,
          unitPrice: l.unitPrice, amount: l.amount, position: i,
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
          unitPrice: Math.round((bal.outstanding / (1 + taxRate / 100)) * 100) / 100,
        }];

    const totals = computeTotals(lines, taxRate);
    if (totals.total > bal.outstanding + 0.02) {
      return reply.code(400).send({
        error: `That credits ${totals.total.toFixed(2)} but only ${bal.outstanding.toFixed(2)} is outstanding.`,
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
        documentId: cid, description: l.description, quantity: money(l.quantity),
        unitPrice: money(l.unitPrice), amount: money(l.quantity * l.unitPrice), position: i,
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
    } else if (!settled && doc.status === 'paid') {
      await db.update(documents).set({ status: 'sent' })
        .where(tenantWhere(documents, accountId, eq(documents.id, id)));
    }
    return reply.code(201).send({ ok: true, ...bal });
  });

  app.delete('/api/v1/payments/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const res = await db.delete(payments).where(tenantWhere(payments, accountId, eq(payments.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
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
    const cur = doc.currency;
    const fmt = (v: string | number) => `${cur} ${Number(v).toFixed(2)}`;

    const lineText = lines.map((l) => `  - ${l.description}: ${Number(l.quantity)} x ${fmt(l.unitPrice)} = ${fmt(l.amount)}`).join('\n');
    const label = doc.type === 'quote' ? 'Quotation' : 'Invoice';
    // A one-click way to pay, when PayFast is on. Invoices only, never quotes.
    const payLink = doc.type === 'invoice' && doc.status !== 'paid'
      ? await payLinkFor(accountId, doc.id) : null;
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
