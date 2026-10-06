/**
 * Nobody is chased for money they have already paid.
 *
 * Reminders, final notices and hosting suspensions used to pick invoices by status
 * alone. Status only turns to "paid" when recorded money covers the total to the
 * cent, so these were chased for the FULL amount:
 *   - paid in full but still marked sent (an older record, or a status set by hand)
 *   - settled by a credit note
 *   - paid a few cents short (rounding, a bank fee)
 * Each case below is checked against the real daily jobs.
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
  body: JSON.stringify({ password: 'paidpass12345', accountName: `Paid ${tag}`, name: 'Pat Paid', email: `paid.${tag}@test.local`, blueprint: 'agency', currency: 'ZAR', vatRegistered: true, vatNumber: '4111111111' }),
});
const cookie = cookieOf(r);
const account = (await r.json()).account;
const A = async (method, p, b) => {
  const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = ?', [account.id]);
// Remind on the due date, so every invoice below is due a reminder today.
await db.query('UPDATE businesses SET reminders_enabled = 1, reminder_offsets = ? WHERE id = ?', [JSON.stringify([0]), biz.id]);
const today = new Date().toISOString().slice(0, 10);
const folder = (await A('POST', '/folders', { name: 'Careful Client', businessId: biz.id, billingEmail: `careful.${tag}@test.local` })).body.folder.id;

let seq = 9000;
const invoice = async (total, extra = {}) => {
  seq++;
  const [res] = await db.query(`INSERT INTO documents (account_id, business_id, type, seq, number, folder_id, client_name, issue_date, due_date, status, total, subtotal, subscription_id)
    VALUES (?, ?, 'invoice', ?, ?, ?, 'Careful Client', ?, ?, 'sent', ?, ?, ?)`,
  [account.id, biz.id, seq, `INV-${seq}`, folder, today, today, total, total, extra.subscriptionId ?? null]);
  return res.insertId;
};
const pay = (docId, amount) => db.query('INSERT INTO payments (account_id, document_id, amount, paid_on) VALUES (?, ?, ?, ?)', [account.id, docId, amount, today]);
const state = async (id) => (await db.query('SELECT status, last_reminder_on r FROM documents WHERE id = ?', [id]))[0][0];

const paidInFull = await invoice(287.5); await pay(paidInFull, 287.5);
const centsShort = await invoice(287.5); await pay(centsShort, 287);
const partPaid = await invoice(287.5); await pay(partPaid, 250);
const unpaid = await invoice(287.5);
const credited = await invoice(500);
seq++;
await db.query(`INSERT INTO documents (account_id, business_id, type, seq, number, folder_id, client_name, issue_date, status, total, subtotal, source_document_id)
  VALUES (?, ?, 'credit_note', ?, ?, ?, 'Careful Client', ?, 'sent', 500, 500, ?)`, [account.id, biz.id, seq, `CN-${seq}`, folder, today, credited]);

const { runInvoiceReminders } = await import('file:///C:/CC/klippy-v2/api/dist/lib/jobs.js');
const summary = await runInvoiceReminders();

const s1 = await state(paidInFull);
ok(!s1.r, 'paid in full but still marked sent: not chased', s1.r);
ok(s1.status === 'paid', 'and it is marked paid now', s1.status);
const s2 = await state(credited);
ok(!s2.r && s2.status === 'paid', 'settled by a credit note: not chased, marked paid', `${s2.status}, ${s2.r}`);
const s3 = await state(centsShort);
ok(!s3.r, 'fifty cents short: not chased over rounding', s3.r);
const s4 = await state(partPaid);
ok(s4.r === today && s4.status === 'sent', 'part paid, R37.50 still owed: chased', s4.r);
const s5 = await state(unpaid);
ok(s5.r === today, 'not paid at all: chased', s5.r);
ok(/found already paid/.test(summary), 'the run reports what it found already paid', summary);

// Manual chase uses the same line.
const chase = await A('GET', '/collections');
ok(chase.status === 200, 'the Owed to you list still loads', chase.status);

// ---- hosting: a paid-up subscription is never overdue ----------------------------
const { oldestOverdueDays } = await import('file:///C:/CC/klippy-v2/api/dist/lib/hosting.js');
const off = (await A('POST', '/offerings', { businessId: biz.id, name: 'Hosting', price: 250, recurring: true })).body.offering.id;
const sub = (await A('POST', '/subscriptions', { businessId: biz.id, offeringId: off, folderId: folder })).body.subscription.id;
const longAgo = '2026-01-01';
const hostInv = await invoice(287.5, { subscriptionId: sub });
await db.query('UPDATE documents SET due_date = ?, issue_date = ? WHERE id = ?', [longAgo, longAgo, hostInv]);
// The first invoice raised when the subscription started is a draft, so only ours counts.
ok(await oldestOverdueDays(account.id, sub, today) > 200, 'an unpaid hosting invoice counts as overdue');
await pay(hostInv, 287.5);
ok(await oldestOverdueDays(account.id, sub, today) === null, 'once the money covers it, the website is not overdue, whatever the status says');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
