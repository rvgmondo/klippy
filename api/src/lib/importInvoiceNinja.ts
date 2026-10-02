import { eq, inArray, isNull, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  folders, contacts, documents, documentLines, payments, offerings, subscriptions, businesses,
} from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';
import { IMPORTED_SEQ_BASE } from './numbering.js';

/**
 * Bring a workspace in from an Invoice Ninja export.
 *
 * Invoice Ninja exports one CSV per kind of record. The browser reads them and
 * hands over the rows as objects keyed by the column headings; this decides what
 * to make of them. Clients and their people are the point (re-typing everybody is
 * what stops a person switching); old invoices, quotes and payments come along as
 * history to sort through, and repeating invoices are optional.
 *
 * It assumes the business is ALREADY in use, because the first person to use it
 * had run both systems side by side for a while:
 *  - each client is matched to one already in Klippy where it can be (same name,
 *    same email, or one name contained in the other, "Early Bird Co" and "Early
 *    Bird Coffee Co"), and the preview lets the person change every match, so
 *    nothing is made twice and running it again changes nothing;
 *  - a matched client only has its BLANK details filled in; nothing typed into
 *    Klippy is overwritten by the older system;
 *  - old documents keep their number as text but are numbered in the imported
 *    range (see IMPORTED_SEQ_BASE), so the old MB-10408 and Klippy's own MBI-10408
 *    both exist, Klippy's next number does not move, and nothing old is ever
 *    chased automatically;
 *  - the export has no invoice lines, so each document gets one line for its total;
 *  - payments are not linked to invoices in the export, so each client's payments
 *    are matched to their invoices oldest first, and any shortfall is filled so that
 *    every invoice ends exactly as paid as Invoice Ninja said;
 *  - repeating invoices come in as drafts (never emailed) and their next date is
 *    moved forward to today or later, and a client already billed on repeat in
 *    Klippy is left alone.
 * Nothing here sends an email or calls anything outside the database.
 */

type Row = Record<string, string>;
export interface NinjaFiles {
  clients?: Row[]; contacts?: Row[]; invoices?: Row[]; quotes?: Row[]; recurring?: Row[]; payments?: Row[];
}
/** What to do with one client from the export: an existing client's id, a new one, or leave it out. */
export type ClientChoice = number | 'new' | 'skip';
export interface NinjaOptions {
  businessId: number;
  /** Keyed by the export client's name. Anything missing takes the suggestion. */
  choices?: Record<string, ClientChoice>;
  include: { contacts: boolean; invoices: boolean; quotes: boolean; payments: boolean; recurring: boolean };
  dryRun: boolean;
}

// ---- pure helpers (unit tested) ---------------------------------------------------

export const money = (s: string | undefined) => {
  const n = Number(String(s ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const clean = (s: string | undefined) => (s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const isoDate = (s: string | undefined) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((s ?? '').trim());
  return m ? m[1]! : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A company name with the noise taken out, for matching only. */
export function nameCore(s: string): string {
  return s.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\((pty|proprietary)\)/g, ' ')
    .replace(/\b(pty|ltd|limited|inc|cc|llc|npc|proprietary|co|company)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Do two client names look like the same client? Equal once the noise is gone, or
 * every word of the shorter one appears in the longer one (at least two words, so
 * "Studio" alone never swallows "Centred Studio").
 */
export function sameClient(a: string, b: string): boolean {
  const x = nameCore(a); const y = nameCore(b);
  if (!x || !y) return false;
  if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const sw = short.split(' '); const lw = new Set(long.split(' '));
  return sw.length >= 2 && sw.every((w) => lw.has(w));
}

/** The client's display name, falling back to its contact when the name is blank. */
export function clientName(r: Row): string {
  const n = (r['Name'] ?? r['Client Name'] ?? '').trim();
  if (n) return n;
  return [r['First Name'] ?? r['Contact First Name'], r['Last Name'] ?? r['Contact Last Name']]
    .map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
}

/** Entries that look like tests, so the preview can leave them out. */
export function looksLikeJunk(name: string): string | null {
  return /^(test\b|company name$|client name$|sample\b|example\b)/i.test(name.trim()) ? 'Looks like a test entry' : null;
}

/**
 * A made-up address (Invoice Ninja fills one in when a client has none). The
 * client is real; the address is not, and emailing it would bounce.
 */
export const realEmail = (e: string | undefined | null) => {
  const v = (e ?? '').trim();
  return v.includes('@') && !/@example\.(com|org|net)$/i.test(v) && !/^email@/i.test(v) ? v : null;
};

/** "MB-10409" -> { prefix: "MB-", seq: 10409 }. */
export function splitNumber(n: string): { prefix: string; seq: number } | null {
  const m = /^(.*?)(\d+)$/.exec(n.trim());
  if (!m) return null;
  const seq = Number(m[2]);
  return seq < IMPORTED_SEQ_BASE / 4 ? { prefix: m[1]!, seq } : null;
}

/** Roll a date forward by whole intervals until it is today or later. */
export function rollForward(start: string, months: number, today: string): string {
  const [y, mo, d] = start.split('-').map(Number) as [number, number, number];
  let year = y; let month = mo;
  const fmt = () => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  };
  let out = fmt();
  for (let i = 0; i < 1200 && out < today; i++) {
    month += months;
    while (month > 12) { month -= 12; year += 1; }
    out = fmt();
  }
  return out;
}

export function paymentMethod(m: string | undefined): string {
  const s = (m ?? '').toLowerCase();
  if (/card|visa|master|amex/.test(s)) return 'Card';
  if (/bank|transfer|eft/.test(s)) return 'EFT';
  if (/cash/.test(s)) return 'Cash';
  return 'Other';
}

type Pay = { date: string; amount: number; method: string; ref: string };
/**
 * Match one client's payments to their invoices, oldest first.
 * Returns, per invoice number, the payments to record. Any invoice still short of
 * what Invoice Ninja said was paid gets one more payment for the gap, dated on the
 * invoice, so balances come out exactly right even when the payments file and the
 * invoices file disagree (they do: deleted payments, zero-amount entries).
 */
export function allocatePayments(invs: { number: string; date: string; paid: number }[], pays: Pay[]): Map<string, Pay[]> {
  const out = new Map<string, Pay[]>();
  const queue = pays.filter((p) => p.amount > 0).sort((a, b) => a.date.localeCompare(b.date)).map((p) => ({ ...p }));
  for (const inv of [...invs].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))) {
    let need = round2(inv.paid);
    const got: Pay[] = [];
    while (need > 0.004 && queue.length) {
      const p = queue[0]!;
      const take = Math.min(need, p.amount);
      got.push({ date: p.date < inv.date ? inv.date : p.date, amount: round2(take), method: p.method, ref: p.ref });
      p.amount = round2(p.amount - take);
      need = round2(need - take);
      if (p.amount <= 0.004) queue.shift();
    }
    if (need > 0.004) got.push({ date: inv.date, amount: need, method: 'Other', ref: 'balance from Invoice Ninja' });
    if (got.length) out.set(inv.number, got);
  }
  return out;
}

// ---- the plan ------------------------------------------------------------------------

interface PlannedClient {
  name: string; email: string | null; phone: string | null; address: string | null;
  vat: string | null; reg: string | null; website: string | null; terms: number | null;
  notes: string | null; country: string | null; since: string | null;
  junk: string | null; inClientsFile: boolean;
  people: { name: string; email: string | null; phone: string | null }[];
}
type Existing = { id: number; name: string; billingEmail: string | null };

export async function importInvoiceNinja(accountId: number, userId: number, files: NinjaFiles, opts: NinjaOptions) {
  const today = new Date().toISOString().slice(0, 10);
  const [biz] = await db.select({ id: businesses.id, name: businesses.name, currency: businesses.currency }).from(businesses)
    .where(tenantWhere(businesses, accountId, eq(businesses.id, opts.businessId))).limit(1);
  if (!biz) throw new Error('That business is not in this workspace.');

  // Clients already in this business.
  // Clients only: an internal folder (pillar "operations") is not somebody to bill.
  const existing: Existing[] = await db.select({ id: folders.id, name: folders.name, billingEmail: folders.billingEmail })
    .from(folders)
    .where(tenantWhere(folders, accountId, eq(folders.businessId, opts.businessId), isNull(folders.parentId),
      isNull(folders.deletedAt), ne(folders.pillar, 'operations')));
  const existingIds = new Set(existing.map((e) => e.id));

  // ---- clients, merged by name ----
  const planned = new Map<string, PlannedClient>();
  const blank = (name: string): PlannedClient => ({
    name, email: null, phone: null, address: null, vat: null, reg: null, website: null, terms: null,
    notes: null, country: null, since: null, junk: null, inClientsFile: false, people: [],
  });
  for (const r of files.clients ?? []) {
    const name = clientName(r);
    if (!name) continue;
    const k = key(name);
    const email = realEmail(r['Email'] ?? r['Contact Email']);
    const phone = (r['Client Phone'] ?? '').trim() || (r['Contact Phone'] ?? '').trim() || null;
    const address = [r['Street'], r['Apt/Suite'], r['City'], r['State/Province'], r['Postal Code']]
      .map((x) => clean(x)).filter(Boolean).join(', ') || null;
    const c = planned.get(k) ?? blank(name);
    c.inClientsFile = true;
    // A duplicate row fills in whatever the first copy was missing.
    c.email ??= email; c.phone ??= phone; c.address ??= address;
    c.country ??= /south africa/i.test(r['Country'] ?? '') ? 'ZA' : null;
    c.vat ??= clean(r['VAT Number']).replace(/^vat\s*(no|number)?\.?:?\s*/i, '') || null;
    c.reg ??= clean(r['ID Number']).replace(/^reg(istration)?\s*(no|number)?\.?:?\s*/i, '') || null;
    c.website ??= (r['Website'] ?? '').trim() || null;
    const terms = Number(r['Client Payment Terms']);
    if (c.terms == null && (r['Client Payment Terms'] ?? '').trim() !== '' && Number.isFinite(terms) && terms >= 0) c.terms = terms;
    c.notes ??= clean(r['Private Notes']) || null;
    c.junk ??= looksLikeJunk(name);
    const person = [r['First Name'], r['Last Name']].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
    if (person || email) c.people.push({ name: person || email!, email, phone: (r['Contact Phone'] ?? '').trim() || null });
    planned.set(k, c);
  }
  // People from the contacts file, attached to their client.
  for (const r of files.contacts ?? []) {
    const c = planned.get(key(clientName(r)));
    if (!c) continue;
    const person = [r['Contact First Name'], r['Contact Last Name']].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
    const email = realEmail(r['Contact Email']);
    if (!person && !email) continue;
    c.people.push({ name: person || email!, email, phone: (r['Contact Phone'] ?? '').trim() || null });
  }
  for (const c of planned.values()) {
    const seen = new Set<string>();
    c.people = c.people.filter((p) => {
      const k2 = key(p.email ?? p.name);
      if (seen.has(k2) || looksLikeJunk(p.name)) return false;
      seen.add(k2);
      return true;
    });
  }
  // Documents can name clients the clients file does not have.
  for (const r of [...(files.invoices ?? []), ...(files.quotes ?? []), ...(files.recurring ?? [])]) {
    const name = (r['Client Name'] ?? '').trim();
    if (!name) continue;
    if (!planned.has(key(name))) planned.set(key(name), blank(name));
    const c = planned.get(key(name))!;
    const d = isoDate(r['Invoice Date'] ?? r['Quote Date']);
    if (d && (!c.since || d < c.since)) c.since = d;
  }

  // ---- what happens to each client ----
  const suggest = (c: PlannedClient): ClientChoice => {
    const match = existing.find((e) => key(e.name) === key(c.name))
      ?? (c.email ? existing.find((e) => e.billingEmail && key(e.billingEmail) === key(c.email!)) : undefined)
      ?? existing.find((e) => sameClient(e.name, c.name));
    if (match) return match.id;
    return c.junk ? 'skip' : 'new';
  };
  const choiceOf = new Map<string, ClientChoice>();
  for (const c of planned.values()) {
    const asked = opts.choices?.[c.name];
    const ok = asked === 'new' || asked === 'skip' || (typeof asked === 'number' && existingIds.has(asked));
    choiceOf.set(key(c.name), ok ? asked! : suggest(c));
  }
  const wanted = [...planned.values()].filter((c) => choiceOf.get(key(c.name)) !== 'skip');
  const wantedKeys = new Set(wanted.map((c) => key(c.name)));

  // ---- documents ----
  const existingDocs = await db.select({ type: documents.type, seq: documents.seq }).from(documents)
    .where(tenantWhere(documents, accountId, eq(documents.businessId, opts.businessId)));
  const taken = new Set(existingDocs.map((d) => `${d.type}:${d.seq}`));
  const invStatus = (s: string) => (/cancel|revers/i.test(s) ? 'void' : /draft/i.test(s) ? 'draft' : /^paid$/i.test(s) ? 'paid' : 'sent');
  // An expired quote is no longer open, so it must not sit in "waiting on a decision".
  const quoteStatus = (s: string) => (/draft/i.test(s) ? 'draft' : /convert|approv|accept/i.test(s) ? 'accepted' : /expire|cancel|declin/i.test(s) ? 'void' : 'sent');

  type PlannedDoc = {
    type: 'invoice' | 'quote'; number: string; seq: number; client: string; issue: string; due: string | null;
    total: number; subtotal: number; tax: number; paid: number; status: string; notes: string | null; skip?: string;
  };
  const docs: PlannedDoc[] = [];
  const addDoc = (d: PlannedDoc) => {
    if (!wantedKeys.has(key(d.client))) d.skip = 'client left out';
    else if (taken.has(`${d.type}:${d.seq}`)) d.skip = 'already imported';
    taken.add(`${d.type}:${d.seq}`);
    docs.push(d);
  };
  if (opts.include.invoices) {
    for (const r of files.invoices ?? []) {
      const number = (r['Invoice Invoice Number'] ?? '').trim();
      const sp = splitNumber(number);
      const issue = isoDate(r['Invoice Date']);
      if (!sp || !issue) continue;
      const total = money(r['Invoice Amount']);
      addDoc({
        type: 'invoice', number, seq: IMPORTED_SEQ_BASE + sp.seq, client: (r['Client Name'] ?? '').trim(),
        issue, due: isoDate(r['Invoice Due Date']) ?? issue,
        total, subtotal: money(r['Invoice Subtotal'] || r['Invoice Amount']),
        tax: money(r['Invoice Tax Amount']), paid: Math.min(money(r['Invoice Paid to Date']), total),
        status: invStatus(r['Invoice Status'] ?? ''), notes: clean(r['Invoice Private Notes']) || null,
      });
    }
  }
  if (opts.include.quotes) {
    for (const r of files.quotes ?? []) {
      const number = (r['Quote Number'] ?? '').trim();
      const sp = splitNumber(number);
      const issue = isoDate(r['Quote Date']);
      if (!sp || !issue) continue;
      addDoc({
        type: 'quote', number, seq: IMPORTED_SEQ_BASE + sp.seq, client: (r['Client Name'] ?? '').trim(),
        issue, due: isoDate(r['Quote Valid Until']), total: money(r['Quote Amount']),
        subtotal: money(r['Quote Subtotal'] || r['Quote Amount']), tax: money(r['Quote Tax Amount']), paid: 0,
        status: quoteStatus(r['Quote Status'] ?? ''), notes: clean(r['Quote Private Notes']) || null,
      });
    }
  }
  const live = docs.filter((d) => !d.skip);

  // ---- payments, matched per client ----
  const payPlan = new Map<string, Pay[]>();
  if (opts.include.payments && opts.include.invoices) {
    const byClient = new Map<string, Pay[]>();
    for (const r of files.payments ?? []) {
      const date = isoDate(r['Payment Date']);
      const amount = round2(money(r['Payment Amount']) - money(r['Payment Refunded']));
      if (!date || amount <= 0) continue;
      const k = key(r['Client Name'] ?? '');
      const list = byClient.get(k) ?? [];
      list.push({ date, amount, method: paymentMethod(r['Payment Method'] ?? r['Payment Type']), ref: (r['Payment Transaction Reference'] ?? '').trim().slice(0, 60) });
      byClient.set(k, list);
    }
    const invsByClient = new Map<string, { number: string; date: string; paid: number }[]>();
    for (const d of live) {
      if (d.type !== 'invoice' || d.status === 'void' || d.status === 'draft' || d.paid <= 0) continue;
      const list = invsByClient.get(key(d.client)) ?? [];
      list.push({ number: d.number, date: d.issue, paid: d.paid });
      invsByClient.set(key(d.client), list);
    }
    for (const [k, invs] of invsByClient) {
      for (const [num, list] of allocatePayments(invs, byClient.get(k) ?? [])) payPlan.set(num, list);
    }
  }

  // ---- repeating invoices ----
  type PlannedRepeat = { client: string; amount: number; every: number; next: string; started: string; status: 'active' | 'paused' };
  const repeats: PlannedRepeat[] = [];
  if (opts.include.recurring) {
    for (const r of files.recurring ?? []) {
      const client = (r['Client Name'] ?? '').trim();
      if (!wantedKeys.has(key(client))) continue;
      const st = (r['Recurring Invoice Status'] ?? r['Status'] ?? '').toLowerCase();
      if (/stop|complete|cancel|draft/.test(st)) continue;
      const how = (r['Recurring Invoice How Often'] ?? r['Recurring Invoice Frequency'] ?? '').toLowerCase();
      const every = /quarter|three month/.test(how) ? 3 : /annual|year/.test(how) ? 12 : /six month|semi/.test(how) ? 6 : /two month/.test(how) ? 2 : 1;
      const nextRaw = isoDate(r['Recurring Invoice Next Send Date']) ?? today;
      repeats.push({
        client, amount: money(r['Recurring Invoice Amount']), every,
        next: rollForward(nextRaw, every, today), started: isoDate(r['Recurring Invoice Date']) ?? nextRaw,
        status: /pause/.test(st) ? 'paused' : 'active',
      });
    }
  }

  // ---- the preview, which is also the report ----
  const nameOf = new Map(existing.map((e) => [e.id, e.name]));
  const matchedName = (client: string) => {
    const ch = choiceOf.get(key(client));
    return typeof ch === 'number' ? nameOf.get(ch) ?? null : null;
  };
  const owedRows = live.filter((d) => d.type === 'invoice' && d.status === 'sent' && d.total - d.paid > 0.004);
  const preview = {
    business: biz.name,
    existing: existing.map((e) => ({ id: e.id, name: e.name })).sort((a, b) => a.name.localeCompare(b.name)),
    clients: [...planned.values()].map((c) => {
      const ch = choiceOf.get(key(c.name))!;
      return {
        name: c.name, email: c.email, phone: c.phone, people: c.people.length, junk: c.junk,
        onlyInDocuments: !c.inClientsFile,
        documents: docs.filter((d) => key(d.client) === key(c.name)).length,
        choice: ch, matchedName: typeof ch === 'number' ? nameOf.get(ch) ?? null : null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name)),
    counts: {
      newClients: wanted.filter((c) => choiceOf.get(key(c.name)) === 'new').length,
      matchedClients: wanted.filter((c) => typeof choiceOf.get(key(c.name)) === 'number').length,
      leftOut: planned.size - wanted.length,
      people: opts.include.contacts ? wanted.reduce((s, c) => s + c.people.length, 0) : 0,
      invoices: live.filter((d) => d.type === 'invoice').length,
      quotes: live.filter((d) => d.type === 'quote').length,
      alreadyImported: docs.filter((d) => d.skip === 'already imported').length,
      payments: live.reduce((s, d) => s + (payPlan.get(d.number)?.length ?? 0), 0),
      repeating: repeats.length,
      unpaidInvoices: owedRows.length,
      unpaidTotal: round2(owedRows.reduce((s, d) => s + d.total - d.paid, 0)),
    },
  };
  if (opts.dryRun) return { preview, done: false };

  // ---- write it, all or nothing ----
  const added = { clients: 0, filled: 0, people: 0, invoices: 0, quotes: 0, payments: 0, repeating: 0 };
  await db.transaction(async (tx) => {
    const folderOf = new Map<string, number>();
    for (const c of wanted) {
      const ch = choiceOf.get(key(c.name))!;
      if (typeof ch === 'number') {
        folderOf.set(key(c.name), ch);
        // Fill in only what Klippy does not already have.
        const [cur] = await tx.select().from(folders).where(tenantWhere(folders, accountId, eq(folders.id, ch))).limit(1);
        if (!cur) continue;
        const patch: Partial<typeof folders.$inferInsert> = {};
        if (!cur.billingEmail && c.email) patch.billingEmail = c.email.slice(0, 150);
        if (!cur.billingPhone && c.phone) patch.billingPhone = c.phone.slice(0, 40);
        if (!cur.billingAddress && c.address) patch.billingAddress = c.address;
        if (!cur.billingVatNumber && c.vat) patch.billingVatNumber = c.vat.slice(0, 60);
        if (!cur.regNumber && c.reg) patch.regNumber = c.reg.slice(0, 60);
        if (!cur.website && c.website) patch.website = c.website.slice(0, 255);
        if (cur.paymentTermsDays == null && c.terms != null) patch.paymentTermsDays = c.terms;
        if (!cur.country && c.country) patch.country = c.country;
        if (c.since && (!cur.clientSince || c.since < cur.clientSince)) patch.clientSince = c.since;
        if (Object.keys(patch).length) {
          await tx.update(folders).set(patch).where(tenantWhere(folders, accountId, eq(folders.id, ch)));
          added.filled++;
        }
        continue;
      }
      const ins = await tx.insert(folders).values(withTenant(accountId, {
        businessId: opts.businessId, parentId: null, name: c.name.slice(0, 150), pillar: 'delivery' as const,
        position: 0, createdBy: userId, notes: c.notes,
        billingEmail: c.email?.slice(0, 150) ?? null, billingPhone: c.phone?.slice(0, 40) ?? null,
        billingAddress: c.address, billingVatNumber: c.vat?.slice(0, 60) ?? null,
        regNumber: c.reg?.slice(0, 60) ?? null, website: c.website?.slice(0, 255) ?? null,
        paymentTermsDays: c.terms, country: c.country, clientSince: c.since, source: 'Invoice Ninja',
      }));
      folderOf.set(key(c.name), Number(ins[0].insertId));
      added.clients++;
    }

    if (opts.include.contacts) {
      const ids = [...new Set(folderOf.values())];
      const have = ids.length ? await tx.select({ folderId: contacts.folderId, email: contacts.email, name: contacts.name }).from(contacts)
        .where(tenantWhere(contacts, accountId, inArray(contacts.folderId, ids))) : [];
      const haveKeys = new Set(have.flatMap((h) => [`${h.folderId}:${key(h.name)}`, ...(h.email ? [`${h.folderId}:${key(h.email)}`] : [])]));
      for (const c of wanted) {
        const fid = folderOf.get(key(c.name))!;
        for (const p of c.people) {
          if (haveKeys.has(`${fid}:${key(p.name)}`) || (p.email && haveKeys.has(`${fid}:${key(p.email)}`))) continue;
          haveKeys.add(`${fid}:${key(p.name)}`);
          if (p.email) haveKeys.add(`${fid}:${key(p.email)}`);
          const ins = await tx.insert(contacts).values(withTenant(accountId, {
            businessId: opts.businessId, folderId: fid, name: p.name.slice(0, 120),
            email: p.email?.slice(0, 150) ?? null, phone: p.phone?.slice(0, 40) ?? null,
            company: c.name.slice(0, 150), createdBy: userId,
          }));
          added.people++;
          // The first person becomes the main contact of a client that has none.
          await tx.update(folders).set({ primaryContactId: Number(ins[0].insertId) })
            .where(tenantWhere(folders, accountId, eq(folders.id, fid), isNull(folders.primaryContactId)));
        }
      }
    }

    for (const d of live) {
      const fid = folderOf.get(key(d.client)) ?? null;
      const c = planned.get(key(d.client));
      const ins = await tx.insert(documents).values(withTenant(accountId, {
        businessId: opts.businessId, type: d.type, seq: d.seq, number: d.number.slice(0, 30), folderId: fid,
        // Under the name the client has in Klippy, so one client reads as one client
        // in every list, whatever the old system called them.
        clientName: (matchedName(d.client) ?? d.client).slice(0, 150), clientEmail: c?.email?.slice(0, 150) ?? null,
        clientAddress: c?.address ?? null, clientVatNumber: c?.vat?.slice(0, 60) ?? null,
        issueDate: d.issue, dueDate: d.due, status: d.status as 'draft' | 'sent' | 'accepted' | 'paid' | 'void',
        currency: biz.currency ?? 'ZAR',
        taxRate: d.subtotal > 0 && d.tax > 0 ? String(round2((d.tax / d.subtotal) * 100)) : '0',
        subtotal: String(d.subtotal || d.total), taxAmount: String(d.tax), total: String(d.total),
        notes: ['Brought over from Invoice Ninja.', d.notes].filter(Boolean).join(' '), createdBy: userId,
        ...(d.type === 'quote' && d.status === 'accepted' ? { decision: 'accepted' as const } : {}),
      }));
      const docId = Number(ins[0].insertId);
      added[d.type === 'quote' ? 'quotes' : 'invoices']++;
      const net = d.subtotal || d.total;
      await tx.insert(documentLines).values(withTenant(accountId, {
        documentId: docId, description: `${d.type === 'quote' ? 'Quote' : 'Invoice'} ${d.number} from Invoice Ninja`,
        quantity: '1', unitPrice: String(net), amount: String(net), position: 0,
      }));
      for (const p of payPlan.get(d.number) ?? []) {
        await tx.insert(payments).values(withTenant(accountId, {
          documentId: docId, amount: String(p.amount), paidOn: p.date, method: p.method,
          note: (p.ref ? `From Invoice Ninja, ref ${p.ref}` : 'From Invoice Ninja').slice(0, 255), createdBy: userId,
        }));
        added.payments++;
      }
    }

    if (repeats.length) {
      // One price list item for the repeating fee, priced at the most common amount;
      // anyone paying something else keeps their own price on their subscription.
      const counts = new Map<number, number>();
      for (const r of repeats) counts.set(r.amount, (counts.get(r.amount) ?? 0) + 1);
      const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const [have] = await tx.select({ id: offerings.id }).from(offerings)
        .where(tenantWhere(offerings, accountId, eq(offerings.businessId, opts.businessId), eq(offerings.name, 'Website hosting'))).limit(1);
      const offeringId = have?.id ?? Number((await tx.insert(offerings).values(withTenant(accountId, {
        businessId: opts.businessId, name: 'Website hosting', price: String(common), unit: 'month',
        recurring: true, createdBy: userId,
      })))[0].insertId);
      // A client already billed on repeat in Klippy is left alone, whatever for.
      const subsHave = await tx.select({ folderId: subscriptions.folderId }).from(subscriptions)
        .where(tenantWhere(subscriptions, accountId, eq(subscriptions.businessId, opts.businessId)));
      const subbed = new Set(subsHave.map((s) => s.folderId));
      for (const r of repeats) {
        const fid = folderOf.get(key(r.client));
        if (!fid || subbed.has(fid)) continue;
        subbed.add(fid);
        await tx.insert(subscriptions).values(withTenant(accountId, {
          businessId: opts.businessId, offeringId, folderId: fid, status: r.status,
          price: r.amount === common ? null : String(r.amount), autoSend: false,
          intervalMonths: r.every, startedOn: r.started, nextBillDate: r.next, createdBy: userId,
        }));
        added.repeating++;
      }
    }
  });
  return { preview, done: true, added };
}
