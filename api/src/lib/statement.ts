import { eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, folders, payments } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
import { currencyFor } from './currencyFor.js';

/**
 * One client's statement, built in one place.
 *
 * This logic used to live inside the /statements route, which meant the on-screen
 * statement, the emailed PDF and the bulk-chase attachment could each have drifted
 * into their own arithmetic. It also carried a real correctness bug: a date-ranged
 * statement simply filtered activity to the range, so "statement from March"
 * silently omitted February's unpaid balance and its closing figure misstated what
 * was owed. The fix is an OPENING BALANCE: everything before `from` is netted into
 * row zero, the way every bank statement works.
 *
 * A running balance only means something within one currency; the statement is
 * produced per currency and reports which others exist.
 */
export interface StatementEntry {
  date: string;
  kind: 'opening' | 'invoice' | 'credit_note' | 'payment' | 'refund';
  ref: string;
  detail: string | null;
  charge: number;
  credit: number;
  balance: number;
}

export interface Statement {
  client: { id: number; name: string; businessId: number | null; billingEmail: string | null };
  from: string | null;
  to: string | null;
  currency: string;
  currencies: string[];
  entries: StatementEntry[];
  summary: { opening: number; invoiced: number; credited: number; received: number; balance: number };
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function buildStatement(
  accountId: number,
  folderId: number,
  opts: { from?: string; to?: string; currency?: string } = {},
): Promise<Statement | null> {
  const { from, to } = opts;
  const wantCurrency = opts.currency?.toUpperCase();

  const [client] = await db.select({
    id: folders.id, name: folders.name, businessId: folders.businessId, billingEmail: folders.billingEmail,
  }).from(folders).where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
  if (!client) return null;

  // Every issued document for this client, unranged: the currency choice and the
  // opening balance both need the full history, not just the window.
  const allDocs = await db.select({
    id: documents.id, type: documents.type, number: documents.number, issueDate: documents.issueDate,
    dueDate: documents.dueDate, total: documents.total, currency: documents.currency,
  }).from(documents)
    .where(tenantWhere(documents, accountId,
      eq(documents.folderId, folderId),
      inArray(documents.type, ['invoice', 'credit_note']),
      ne(documents.status, 'void'),
      ne(documents.status, 'draft'),
    ));

  const currencies = [...new Set(allDocs.map((d) => d.currency))].sort();
  const latest = allDocs.reduce<typeof allDocs[number] | undefined>(
    (best, d) => (!best || d.issueDate > best.issueDate ? d : best), undefined);
  const currency = (wantCurrency && currencies.includes(wantCurrency))
    ? wantCurrency
    : (latest?.currency ?? await currencyFor(accountId, client.businessId));
  const docs = allDocs.filter((d) => d.currency === currency);
  const docIds = docs.map((d) => d.id);
  const numberOf = new Map(docs.map((d) => [d.id, d.number]));

  const allPays = docIds.length
    ? await db.select({
      documentId: payments.documentId, amount: payments.amount,
      paidOn: payments.paidOn, method: payments.method,
    }).from(payments)
      .where(tenantWhere(payments, accountId, inArray(payments.documentId, docIds)))
    : [];

  // The opening balance: all activity strictly before `from`, netted. Without it a
  // ranged statement pretends the account started at zero on the range's first day.
  let opening = 0;
  if (from) {
    for (const d of docs) {
      if (d.issueDate < from) opening += d.type === 'invoice' ? Number(d.total) : -Number(d.total);
    }
    for (const p of allPays) {
      if (p.paidOn < from) opening -= Number(p.amount);
    }
    opening = round(opening);
  }

  const inRange = (date: string) => (!from || date >= from) && (!to || date <= to);
  type Raw = { date: string; kind: 'invoice' | 'credit_note' | 'payment' | 'refund'; ref: string; detail: string | null; charge: number; credit: number };
  const raw: Raw[] = [
    ...docs.filter((d) => inRange(d.issueDate)).map((d): Raw => d.type === 'invoice'
      ? { date: d.issueDate, kind: 'invoice', ref: d.number, detail: d.dueDate ? `due ${d.dueDate}` : null, charge: Number(d.total), credit: 0 }
      : { date: d.issueDate, kind: 'credit_note', ref: d.number, detail: 'credit note', charge: 0, credit: Number(d.total) }),
    ...allPays.filter((p) => inRange(p.paidOn)).map((p): Raw => {
      const amt = Number(p.amount);
      const against = numberOf.get(p.documentId) ?? '';
      return amt < 0
        ? { date: p.paidOn, kind: 'refund', ref: against, detail: `refund${p.method ? ` (${p.method})` : ''}`, charge: -amt, credit: 0 }
        : { date: p.paidOn, kind: 'payment', ref: against, detail: `payment${p.method ? ` (${p.method})` : ''}`, charge: 0, credit: amt };
    }),
  ];
  // Charges before credits on the same day, so the running balance reads right.
  const rank = { invoice: 0, refund: 1, credit_note: 2, payment: 3 };
  raw.sort((a, b) => a.date.localeCompare(b.date) || rank[a.kind] - rank[b.kind]);

  let balance = opening;
  const entries: StatementEntry[] = [];
  if (from && opening !== 0) {
    entries.push({ date: from, kind: 'opening', ref: 'Balance brought forward', detail: null, charge: 0, credit: 0, balance: opening });
  }
  for (const e of raw) {
    balance = round(balance + e.charge - e.credit);
    entries.push({ ...e, charge: round(e.charge), credit: round(e.credit), balance });
  }

  return {
    client,
    from: from ?? null,
    to: to ?? null,
    currency,
    currencies,
    entries,
    summary: {
      opening,
      invoiced: round(raw.reduce((s, e) => s + (e.kind === 'invoice' ? e.charge : 0), 0)),
      credited: round(raw.reduce((s, e) => s + (e.kind === 'credit_note' ? e.credit : 0), 0)),
      received: round(raw.reduce((s, e) => s + (e.kind === 'payment' ? e.credit : 0) - (e.kind === 'refund' ? e.charge : 0), 0)),
      balance: round(balance),
    },
  };
}
