/**
 * Matching a bank statement to open invoices and recording the payments.
 *
 * What would be quietly wrong:
 *   - running the same statement twice paying invoices twice
 *   - a deposit larger than the invoice recorded as if it all belonged there
 *   - a cancelled or already-paid invoice taking a payment
 *   - another workspace's invoices offered as matches, or paid through this
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
const signup = async (email) => {
  const r = await fetch(API + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'bankmatch1234', accountName: `Bank ${tag}`, name: 'Bea Bank', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  const cookie = cookieOf(r);
  const account = (await r.json()).account;
  const A = async (method, p, b) => {
    const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { A, account };
};
const { A, account } = await signup(`bank.${tag}@test.local`);
const biz = (await A('GET', '/businesses')).body.businesses[0];
let seq = 900;
const invoice = async (client, total, status = 'sent') => {
  seq++;
  const [r] = await db.query(`INSERT INTO documents (account_id, business_id, type, seq, number, client_name, issue_date, due_date, status, total, subtotal)
    VALUES (?, ?, 'invoice', ?, ?, ?, '2026-09-01', '2026-09-15', ?, ?, ?)`, [account.id, biz.id, seq, `INV-0${seq}`, client, status, total, total]);
  return { id: r.insertId, number: `INV-0${seq}` };
};
const acme = await invoice('Acme Plumbing', 9200);
const bird = await invoice('Early Bird Coffee', 4600);
const river = await invoice('Riverwalk', 402.5);
const gone = await invoice('Gone Client', 777, 'void');

const csv = [
  '3,Statement period,2026/10/01,2026/10/08',
  'Date,Amount,Balance,Description',
  `2026/10/02,"1,000.00",0,EARLY BIRD ${bird.number.replace('-', '')}`,
  '2026/10/03,9200.00,0,ACME PLUMBING EFT',
  '2026/10/04,402.50,0,Payment Received: Riverwalk',
  '2026/10/05,-350.00,0,HOSTING DEBIT ORDER',
  '2026/10/06,777.00,0,GONE CLIENT',
].join('\n');

const pv = (await A('POST', '/bank-statement/preview', { csv })).body;
const byDesc = (s) => pv.rows?.find((r) => r.description.includes(s));
ok(pv.rows?.length === 4, 'four deposits read, the debit order left out', pv.rows?.length);
ok(byDesc('EARLY BIRD')?.suggestion?.documentId === bird.id && byDesc('EARLY BIRD').suggestion.confidence === 'number', 'a part payment with the invoice number goes to that invoice');
ok(byDesc('ACME')?.suggestion?.documentId === acme.id, 'the exact amount with the client name goes to Acme', byDesc('ACME')?.suggestion?.confidence);
ok(byDesc('Riverwalk')?.suggestion?.documentId === river.id, 'and Riverwalk to Riverwalk');
ok(!byDesc('GONE')?.suggestion && !pv.open.some((o) => o.id === gone.id), 'a cancelled invoice is never offered');

const items = pv.rows.filter((r) => r.suggestion).map((r) => ({ documentId: r.suggestion.documentId, amount: r.amount, paidOn: r.date, reference: r.description }));
const ap = (await A('POST', '/bank-statement/apply', { items })).body;
ok(ap.recorded === 3 && ap.skipped.length === 0, 'the three matches are recorded', JSON.stringify(ap));
const status = async (id) => (await db.query('SELECT status s FROM documents WHERE id = ?', [id]))[0][0].s;
ok(await status(acme.id) === 'paid' && await status(river.id) === 'paid', 'fully paid invoices are marked paid');
ok(await status(bird.id) === 'sent', 'the part-paid one stays open');
const [[pay]] = await db.query('SELECT method, note FROM payments WHERE document_id = ?', [river.id]);
ok(pay.method === 'EFT' && pay.note.includes('Riverwalk'), 'each payment is an EFT with the bank reference on it', pay.note);

const again = (await A('POST', '/bank-statement/apply', { items })).body;
ok(again.recorded === 0 && again.skipped.length === 3, 'the same statement a second time records nothing', JSON.stringify(again.skipped.map((s) => s.reason)));
const pv2 = (await A('POST', '/bank-statement/preview', { csv })).body;
ok(pv2.rows.find((r) => r.description.includes('ACME'))?.alreadyRecorded === acme.number, 'and the preview says it looks recorded already');

const over = (await A('POST', '/bank-statement/apply', { items: [{ documentId: bird.id, amount: 99999, paidOn: '2026-10-07' }] })).body;
ok(over.recorded === 0 && /more than/.test(over.skipped[0]?.reason ?? ''), 'more than is owed is refused', over.skipped[0]?.reason);
const onVoid = (await A('POST', '/bank-statement/apply', { items: [{ documentId: gone.id, amount: 777, paidOn: '2026-10-06' }] })).body;
ok(onVoid.recorded === 0 && /cancelled/.test(onVoid.skipped[0]?.reason ?? ''), 'a cancelled invoice takes no payment');

const bad = await A('POST', '/bank-statement/preview', { csv: 'hello\nworld' });
ok(bad.status === 400 && /date and amount/.test(bad.body.error), 'a file it cannot read gets a plain answer', bad.body.error);

const { A: B } = await signup(`bank.other.${tag}@test.local`);
const theirs = (await B('POST', '/bank-statement/preview', { csv })).body;
ok(!theirs.open.some((o) => o.id === bird.id) && !theirs.rows.some((r) => r.suggestion), 'another workspace sees none of your invoices');
const steal = (await B('POST', '/bank-statement/apply', { items: [{ documentId: bird.id, amount: 100, paidOn: '2026-10-07' }] })).body;
ok(steal.recorded === 0, 'and cannot record a payment on one');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
