/**
 * Reading a bank statement export and matching the money in to open invoices.
 *
 * Every EFT used to mean finding the invoice and pressing Paid by hand. A bank's
 * CSV already says who paid what and when; this reads it and suggests which invoice
 * each deposit settles, and a person ticks the suggestions before anything is
 * recorded. Nothing here writes to the database.
 *
 * SA banks do not agree on a format. FNB puts account details above the header,
 * Capitec and Absa use separate money-in and money-out columns, some write
 * "1 234,56" and some "1,234.56", dates come as 2026/10/08, 08/10/2026 or
 * 08 Oct 2026. The reader finds the header row by its words, falls back to
 * guessing columns from their contents, and only ever keeps money IN.
 */

export interface StatementRow {
  /** Position in the file, so a row can be referred to after a round trip. */
  line: number;
  date: string;
  description: string;
  amount: number;
}

export interface OpenInvoice {
  id: number;
  number: string;
  clientName: string;
  outstanding: number;
  currency: string;
  imported?: boolean;
}

export type Confidence = 'number' | 'amount-and-name' | 'amount';
export interface Suggestion { line: number; documentId: number; confidence: Confidence }

// ---- CSV -----------------------------------------------------------------------------

/** One CSV line into cells, honouring quotes. The delimiter is worked out once per file. */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function pickDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 30).join('\n');
  const count = (d: string) => sample.split(d).length;
  return [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0]!;
}

// ---- dates and money -------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number) => String(n).padStart(2, '0');
const valid = (y: number, m: number, d: number) =>
  y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null;

/** A statement date in any of the usual shapes, as YYYY-MM-DD. Day-first, as SA banks write it. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return valid(+m[3]!, +m[2]!, +m[1]!);
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,4})[a-z]*[\s-](\d{4})/);
  if (m) { const mon = MONTHS[m[2]!.toLowerCase()]; return mon ? valid(+m[3]!, mon, +m[1]!) : null; }
  return null;
}

/** "R 1 234,56", "1,234.56", "-500.00", "(500.00)" into a number. Null when it is not money. */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/^R\s*/i, '').replace(/ZAR/i, '').replace(/[\s ']/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (/cr$/i.test(s)) s = s.slice(0, -2);
  if (/dr$/i.test(s)) { neg = true; s = s.slice(0, -2); }
  // "1.234,56" or "1234,56": the comma is the decimal point.
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -Math.abs(n) : n) : null;
}

// ---- the statement ---------------------------------------------------------------------

/**
 * The deposits in a statement: date, words and amount for every line of money IN.
 * Throws a plain-English error when no dates and amounts can be found at all.
 */
export function readStatement(text: string): { rows: StatementRow[]; skipped: number } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('That file is empty.');
  const delim = pickDelimiter(lines);
  const table = lines.map((l) => splitLine(l, delim));

  // The header: the first row, within the top twenty, that names a date and money.
  let header = -1;
  for (let i = 0; i < Math.min(20, table.length); i++) {
    const words = table[i]!.map((c) => c.toLowerCase());
    if (words.some((w) => /date/.test(w)) && words.some((w) => /amount|credit|money in|deposit|debit|value/.test(w))) { header = i; break; }
  }

  let col: { date: number; desc: number[]; amount: number; credit: number; debit: number };
  if (header >= 0) {
    const h = table[header]!.map((c) => c.toLowerCase());
    const find = (re: RegExp, not?: RegExp) => h.findIndex((w) => re.test(w) && !(not && not.test(w)));
    col = {
      date: find(/date/, /value date|effective/) >= 0 ? find(/date/, /value date|effective/) : find(/date/),
      desc: h.map((w, i) => (/desc|detail|narrat|reference|particular|transaction/.test(w) && !/date|amount|type/.test(w) ? i : -1)).filter((i) => i >= 0),
      amount: find(/^amount|amount$|^value$|amount \(/, /balance/),
      credit: find(/credit|money in|deposit|paid in/, /card/),
      debit: find(/debit|money out|withdraw|paid out/, /card/),
    };
  } else {
    // No header: the column that is always a date, the first column that is always
    // money, and the widest text column.
    const body = table.slice(0, 50);
    const always = (test: (c: string) => boolean) => {
      const width = Math.max(...body.map((r) => r.length));
      const out: number[] = [];
      for (let c = 0; c < width; c++) if (body.filter((r) => r[c] !== undefined && r[c] !== '').every((r) => test(r[c]!))) out.push(c);
      return out;
    };
    const dates = always((c) => parseDate(c) != null);
    const nums = always((c) => parseAmount(c) != null).filter((c) => !dates.includes(c));
    const width = Math.max(...body.map((r) => r.length));
    let desc = -1; let best = -1;
    for (let c = 0; c < width; c++) {
      if (dates.includes(c) || nums.includes(c)) continue;
      const len = body.reduce((t, r) => t + (r[c]?.length ?? 0), 0);
      if (len > best) { best = len; desc = c; }
    }
    col = { date: dates[0] ?? -1, desc: desc >= 0 ? [desc] : [], amount: nums[0] ?? -1, credit: -1, debit: -1 };
  }
  if (col.date < 0 || (col.amount < 0 && col.credit < 0)) {
    throw new Error('Klippy could not find the date and amount columns in that file. Export it from your bank as CSV, with the column names included.');
  }

  const rows: StatementRow[] = [];
  let skipped = 0;
  for (let i = header + 1; i < table.length; i++) {
    const r = table[i]!;
    const date = parseDate(r[col.date] ?? '');
    if (!date) continue; // totals, footers, blank lines
    let amount: number | null;
    if (col.credit >= 0) {
      const cr = parseAmount(r[col.credit] ?? '');
      // A separate credit column: money in is what is in it, whatever its sign.
      amount = cr != null && cr !== 0 ? Math.abs(cr) : null;
      if (amount == null && col.amount >= 0) amount = parseAmount(r[col.amount] ?? '');
    } else {
      amount = parseAmount(r[col.amount] ?? '');
    }
    if (amount == null || amount <= 0) { skipped++; continue; }
    // Several text columns (Capitec has Description and Original Description), each said once.
    const description = [...new Set(col.desc.map((c) => (r[c] ?? '').trim()).filter(Boolean))].join(' ').replace(/\s+/g, ' ').trim();
    rows.push({ line: i + 1, date, description, amount: Math.round(amount * 100) / 100 });
  }
  return { rows, skipped };
}

// ---- matching --------------------------------------------------------------------------

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const STOP = new Set(['THE', 'AND', 'PTY', 'LTD', 'CC', 'INC', 'CO', 'SA', 'GROUP', 'SERVICES', 'SOLUTIONS', 'TRADING', 'HOLDINGS']);

/** Does the deposit's text mention this invoice's number? INV-0012 matches "inv0012", "INV 12" does not. */
function mentionsNumber(desc: string, number: string): boolean {
  const n = squash(number);
  if (n.length < 3 || !/\d/.test(n)) return false;
  const d = squash(desc);
  const at = d.indexOf(n);
  // Not the start of a longer number: INV-001 must not match INV-0012.
  return at >= 0 && !/\d/.test(d[at + n.length] ?? '');
}

/** A distinctive word of the client's name appears in the deposit's text. */
function mentionsClient(desc: string, client: string): boolean {
  const d = ` ${desc.toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
  return client.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)).some((w) => d.includes(` ${w} `));
}

/**
 * Which invoice each deposit most likely pays, best evidence first, and never the
 * same invoice twice in one statement. Three kinds of evidence:
 *   number:           the invoice number is in the reference (what people are asked to use)
 *   amount-and-name:  the exact amount owed, and the client's name in the text
 *   amount:           the exact amount owed, and no other open invoice owes it
 * A deposit with none of these is left for the person to pick, or to ignore.
 */
export function suggestMatches(rows: StatementRow[], open: OpenInvoice[]): Suggestion[] {
  const used = new Set<number>();
  const taken = new Set<number>();
  const out: Suggestion[] = [];
  const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const pass = (confidence: Confidence, pick: (r: StatementRow) => OpenInvoice | undefined) => {
    for (const r of rows) {
      if (taken.has(r.line)) continue;
      const inv = pick(r);
      if (!inv) continue;
      used.add(inv.id); taken.add(r.line);
      out.push({ line: r.line, documentId: inv.id, confidence });
    }
  };
  const free = () => open.filter((o) => !used.has(o.id));
  pass('number', (r) => free().find((o) => mentionsNumber(r.description, o.number)));
  pass('amount-and-name', (r) => {
    const c = free().filter((o) => same(o.outstanding, r.amount) && mentionsClient(r.description, o.clientName));
    return c.length === 1 ? c[0] : undefined;
  });
  pass('amount', (r) => {
    const c = free().filter((o) => same(o.outstanding, r.amount));
    return c.length === 1 ? c[0] : undefined;
  });
  return out.sort((a, b) => a.line - b.line);
}
