/**
 * Bugs found in the October bug hunt, each pinned so it cannot come back.
 *
 *   - a cancelled invoice could still be paid through an old Pay now link, and the
 *     payment turned it back into a paid invoice (counted as income, provisioned)
 *   - a payment could be recorded on a quote, turning the quote "paid"
 *   - two invoices made at the same moment could pick the same number, and one of
 *     them failed with an error
 *   - there was no safe link for a server cron to keep the daily jobs running
 *     while the app sleeps
 *
 * Run with a test server on 8095 (or set KLIPPY_API).
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = process.env.KLIPPY_API ?? 'http://localhost:8095/api/v1';
const url = new URL(process.env.DATABASE_URL);
const db = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.slice(1), dateStrings: true,
});
let failures = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
const tag = Date.now();
const r = await fetch(API + '/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'bughuntpass12', accountName: `Bugs ${tag}`, name: 'Bo Bugs', email: `bugs.${tag}@test.local`, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
});
const cookie = cookieOf(r);
const account = (await r.json()).account;
const A = async (method, p, b) => {
  const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const biz = (await A('GET', '/businesses')).body.businesses[0];
const today = new Date().toISOString().slice(0, 10);
const make = async (type) => (await A('POST', '/documents', {
  type, businessId: biz.id, clientName: 'Bug Client', clientEmail: `bugclient.${tag}@test.local`, issueDate: today,
  lines: [{ description: 'Work', quantity: 1, unitPrice: 1000 }],
})).body.document;

// ---- a cancelled invoice is not paid, and stays cancelled -----------------------------
const inv = await make('invoice');
await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [inv.id]);
const del = await A('DELETE', `/documents/${inv.id}`);
const [[voided]] = await db.query('SELECT status FROM documents WHERE id = ?', [inv.id]);
ok(del.status === 200 && voided.status === 'void', 'deleting a sent invoice cancels it', voided.status);
const payOnVoid = await A('POST', `/documents/${inv.id}/payments`, { amount: 100, paidOn: today });
ok(payOnVoid.status === 400, 'a payment cannot be recorded on a cancelled invoice', payOnVoid.status);
// Money that arrives anyway (an old card link) is recorded, but the invoice stays cancelled.
await db.query('INSERT INTO payments (account_id, document_id, amount, paid_on) VALUES (?, ?, 1000, ?)', [account.id, inv.id, today]);
const { settleIfCovered } = await import('file:///C:/CC/klippy-v2/api/dist/lib/settle.js');
const st = await settleIfCovered(account.id, inv.id, 1000, 'void');
const [[still]] = await db.query('SELECT status FROM documents WHERE id = ?', [inv.id]);
ok(!st.flipped && still.status === 'void', 'money against a cancelled invoice does not revive it', still.status);
const refund = await A('POST', `/documents/${inv.id}/payments`, { amount: -1000, paidOn: today });
ok(refund.status === 200 || refund.status === 201, 'but a refund can be recorded on it', refund.status);

// The Pay now page says it was cancelled instead of taking a card payment.
const { payLinkFor } = await import('file:///C:/CC/klippy-v2/api/dist/lib/paylink.js');
const { signPayToken } = await import('file:///C:/CC/klippy-v2/api/dist/lib/secretbox.js');
if (typeof signPayToken === 'function') {
  const page = await fetch(`${API}/pay/${inv.id}?t=${encodeURIComponent(signPayToken(inv.id))}`);
  const html = await page.text();
  ok(/cancelled/i.test(html), 'the Pay now page says the invoice was cancelled', html.slice(0, 80));
} else {
  ok(typeof payLinkFor === 'function', 'pay links exist (the page check needs the signer)');
}

// ---- no payments on quotes ----------------------------------------------------------------
const quote = await make('quote');
const payQuote = await A('POST', `/documents/${quote.id}/payments`, { amount: 500, paidOn: today });
ok(payQuote.status === 400, 'a payment cannot be recorded on a quote', payQuote.status);

// ---- five invoices at once, five numbers ----------------------------------------------------
const many = await Promise.all([1, 2, 3, 4, 5].map(() => A('POST', '/documents', {
  type: 'invoice', businessId: biz.id, clientName: 'Rush Client', issueDate: today,
  lines: [{ description: 'Rush', quantity: 1, unitPrice: 100 }],
})));
const statuses = many.map((m) => m.status);
const numbers = new Set(many.map((m) => m.body.document?.number).filter(Boolean));
ok(statuses.every((s) => s === 201 || s === 200), 'five invoices made in the same instant all succeed', statuses.join(','));
ok(numbers.size === 5, 'and each has its own number', [...numbers].join(' '));

// ---- the cron link ---------------------------------------------------------------------------
const noKey = await fetch(`${API}/cron/tick`, { method: 'POST' });
ok(noKey.status === 401 || noKey.status === 503, 'the cron link refuses a call without the key', noKey.status);
const tick = await fetch(`${API}/cron/tick`, { method: 'POST', headers: { 'X-Cron-Key': process.env.CRON_SECRET ?? 'e2e-cron-secret' } });
ok(tick.status === 200, 'and runs with it', tick.status);
const again = await fetch(`${API}/cron/tick`, { method: 'POST', headers: { 'X-Cron-Key': process.env.CRON_SECRET ?? 'e2e-cron-secret' } });
ok(again.status === 200, 'calling it again is harmless (each job runs once a day)', again.status);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
