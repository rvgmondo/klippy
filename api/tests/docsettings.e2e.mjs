/**
 * Quotes and credit notes have their own settings and their own wording.
 *
 * They used to borrow the invoice's: a quote said "Payment within 7 days" and a
 * credit note asked to be paid. Each block names what would be quietly wrong:
 *   - the settings save and come back
 *   - a quote shows the quote terms, and bank details only when asked for
 *   - a quote with no terms of its own keeps the invoice terms it always had
 *   - a credit note shows its own note and never bank details or payment terms
 *   - an invoice is unchanged
 *   - the screen and the PDF agree (both go through one rule)
 *   - a backup keeps all of it
 *
 * Run with a test server on 8095 (or set KLIPPY_API).
 */
import 'dotenv/config';

const API = process.env.KLIPPY_API ?? 'http://localhost:8095/api/v1';
let failures = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
const tag = Date.now();
const r = await fetch(API + '/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'docspass12345', accountName: `Docs ${tag}`, name: 'Dee Docs', email: `docs.${tag}@test.local`, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
});
const cookie = cookieOf(r);
const A = async (method, p, b) => {
  const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const biz = (await A('GET', '/businesses')).body.businesses[0];
const today = new Date().toISOString().slice(0, 10);

const INVOICE_TERMS = 'Payment within 7 days.';
const BANK = 'FNB 62800000000';
const set = await A('PATCH', `/businesses/${biz.id}`, {
  invoiceFooter: INVOICE_TERMS, bankDetails: BANK,
  quoteValidDays: 14, quoteDepositPercent: 50, quoteFooter: 'Valid 14 days. Work starts on deposit.',
  quoteShowBank: false, creditNoteFooter: 'This credit reduces the invoice named.',
});
ok(set.status === 200, 'the settings save', set.status);
const back = (await A('GET', '/businesses')).body.businesses[0];
ok(back.quoteValidDays === 14 && Number(back.quoteDepositPercent) === 50 && back.quoteShowBank === false && back.creditNoteFooter,
  'and come back', `${back.quoteValidDays}, ${back.quoteDepositPercent}`);

const make = async (type) => (await A('POST', '/documents', {
  type, businessId: biz.id, clientName: 'Wording Client', issueDate: today,
  lines: [{ description: 'Work', quantity: 1, unitPrice: 1000 }],
})).body.document;
const view = async (id) => (await A('GET', `/documents/${id}`)).body.issuer;

const quote = await make('quote');
let qi = await view(quote.id);
ok(qi.footer === 'Valid 14 days. Work starts on deposit.', 'a quote shows the quote terms', qi.footer);
ok(qi.bankDetails === null, 'and no bank details unless asked for', qi.bankDetails);
await A('PATCH', `/businesses/${biz.id}`, { quoteShowBank: true });
qi = await view(quote.id);
ok(qi.bankDetails === BANK, 'switched on, the quote shows them', qi.bankDetails);
await A('PATCH', `/businesses/${biz.id}`, { quoteFooter: '' });
qi = await view(quote.id);
ok(qi.footer === INVOICE_TERMS, 'a quote with no terms of its own keeps the invoice terms, as before', qi.footer);

const invoice = await make('invoice');
const ii = await view(invoice.id);
ok(ii.footer === INVOICE_TERMS && ii.bankDetails === BANK, 'an invoice is unchanged: its terms and bank details');

const cn = (await A('POST', `/documents/${invoice.id}/credit-note`, { reason: 'Overcharged' })).body.document;
const ci = cn ? await view(cn.id) : null;
ok(ci?.footer === 'This credit reduces the invoice named.', 'a credit note shows its own note, not payment terms', ci?.footer);
ok(ci?.bankDetails === null, 'and never bank details', ci?.bankDetails);

const pdf = await fetch(`${API}/documents/${quote.id}/pdf`, { headers: { cookie } });
ok(pdf.status === 200 && (pdf.headers.get('content-type') ?? '').includes('pdf'), 'the quote PDF still renders', pdf.status);

const zero = await A('PATCH', `/businesses/${biz.id}`, { quoteDepositPercent: 0 });
const z = (await A('GET', '/businesses')).body.businesses[0];
ok(zero.status === 200 && z.quoteDepositPercent === null, 'a 0% deposit means no deposit', z.quoteDepositPercent);

const exp = (await A('GET', '/account/export')).body;
const eb = (exp.data ?? exp).businesses?.[0];
ok(eb?.quoteValidDays === 14 && eb?.creditNoteFooter && eb?.invoiceFooter === INVOICE_TERMS, 'a backup keeps the wording and the quote settings');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
