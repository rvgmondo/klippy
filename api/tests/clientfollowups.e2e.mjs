/**
 * The three things that now happen on their own: quote follow-ups, monthly
 * statements to clients who owe, and the owner's month in money.
 *
 * What would be quietly wrong:
 *   - clients emailed by a business that never switched it on
 *   - a quote nudged twice, or after it was answered, or after it expired
 *   - a statement sent to a client who has paid, or whose reminders are paused
 *   - the month's figures counting drafts, old-system history or other workspaces
 *
 * The jobs are run straight from the built code, on a chosen date, and the mailer
 * (no mail server locally) logs each email it would send, which is what is checked.
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
const r0 = await fetch(API + '/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'followups1234', accountName: `Follow ${tag}`, name: 'Flo Low', email: `follow.${tag}@test.local`, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
});
const cookie = cookieOf(r0);
const account = (await r0.json()).account;
const A = async (method, p, b) => {
  const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const biz = (await A('GET', '/businesses')).body.businesses[0];

// Catch what the mailer would send.
const mail = [];
const realLog = console.log;
const capture = async (fn) => {
  mail.length = 0;
  console.log = (...a) => { const s = a.join(' '); if (s.includes('[mailer:not-configured]')) mail.push(s); else realLog(...a); };
  try { return await fn(); } finally { console.log = realLog; }
};
const mailTo = (who) => mail.filter((m) => m.includes(`to ${who}:`));
const { runQuoteFollowUps, runMonthlyStatements, monthFigures, runMonthReport } = await import('file:///C:/CC/klippy-v2/api/dist/lib/monthly.js');

const folder = async (name, extra = {}) => (await A('POST', '/folders', { name, businessId: biz.id, billingEmail: `${name.replace(/\W/g, '').toLowerCase()}.${tag}@test.local`, ...extra })).body.folder.id;
const owes = await folder('Owes Money');
const paidUp = await folder('Paid Up');
const quiet = await folder('Paused Client');
await db.query('UPDATE folders SET reminders_paused = 1 WHERE id = ?', [quiet]);
const email = (name) => `${name.replace(/\W/g, '').toLowerCase()}.${tag}@test.local`;

let seq = 600;
const doc = async (type, f, fields) => {
  seq++;
  const [r] = await db.query(`INSERT INTO documents (account_id, business_id, type, seq, number, folder_id, client_name, client_email, issue_date, due_date, status, total, subtotal, decision)
    VALUES (?, ?, ?, ?, ?, ?, 'Client', NULL, ?, ?, ?, ?, ?, ?)`,
  [account.id, biz.id, type, fields.seq ?? seq, `${type === 'quote' ? 'QUO' : 'INV'}-${fields.seq ?? seq}`, f, fields.issue, fields.due ?? null, fields.status ?? 'sent', fields.total ?? 1000, fields.total ?? 1000, fields.decision ?? null]);
  return r.insertId;
};

// ---- quote follow-ups -------------------------------------------------------------------------
const day = '2026-11-10';
const stale = await doc('quote', owes, { issue: '2026-11-01', due: '2026-12-01' });
await doc('quote', paidUp, { issue: '2026-11-01', due: '2026-12-01', decision: 'accepted' });
await doc('quote', quiet, { issue: '2026-11-01', due: '2026-11-05' }); // expired
await doc('quote', owes, { issue: '2026-11-09', due: '2026-12-09' }); // too recent

await capture(() => runQuoteFollowUps(day));
ok(mailTo(email('Owes Money')).length === 0, 'with the setting off, no client is emailed', mail.length);

ok((await A('PATCH', `/businesses/${biz.id}`, { quoteFollowUpDays: 4 })).status === 200, 'switching follow-ups on after 4 days saves');
await capture(() => runQuoteFollowUps(day));
const nudges = mail.filter((m) => m.includes(`Following up on quote`) && m.includes(tag));
ok(nudges.length === 1 && nudges[0].includes(email('Owes Money')) && nudges[0].includes(`QUO-${seq - 3}`), 'only the unanswered, unexpired, old-enough quote is followed up', nudges.join(' | '));
const [[st]] = await db.query('SELECT quote_nudged_at n FROM documents WHERE id = ?', [stale]);
ok(!!st.n, 'and it is stamped');
await capture(() => runQuoteFollowUps(day));
ok(mail.filter((m) => m.includes(tag) && m.includes('Following up')).length === 0, 'run again, nobody is followed up twice');

// ---- monthly statements --------------------------------------------------------------------------
await doc('invoice', owes, { issue: '2026-10-01', due: '2026-10-15', total: 2500 });
const settled = await doc('invoice', paidUp, { issue: '2026-10-01', due: '2026-10-15', total: 800 });
await db.query('INSERT INTO payments (account_id, document_id, amount, paid_on) VALUES (?, ?, 800, ?)', [account.id, settled, '2026-10-10']);
await doc('invoice', quiet, { issue: '2026-10-01', due: '2026-10-15', total: 300 });
await doc('invoice', paidUp, { issue: '2020-01-01', due: '2020-01-15', total: 999, seq: 3_000_000_000 + (tag % 100000) }); // old system

await capture(() => runMonthlyStatements('2026-11-01'));
ok(mailTo(email('Owes Money')).length === 0, 'statements stay off until switched on');
await A('PATCH', `/businesses/${biz.id}`, { monthlyStatements: true });
await capture(() => runMonthlyStatements('2026-11-02'));
ok(mail.filter((m) => m.includes(tag)).length === 0, 'and only go on the 1st');
await capture(() => runMonthlyStatements('2026-11-01'));
const stmts = mail.filter((m) => m.includes(tag) && m.includes('Statement of account'));
ok(stmts.length === 1 && stmts[0].includes(email('Owes Money')) && stmts[0].includes('.pdf'), 'the client who owes gets their statement, with the PDF', stmts.join(' | '));
ok(mailTo(email('Paid Up')).length === 0, 'a client who has paid gets nothing, even with old-system history');
ok(mailTo(email('Paused Client')).length === 0, 'and a client whose reminders are paused gets nothing');

// ---- the month in money -----------------------------------------------------------------------------
await doc('invoice', owes, { issue: '2026-10-20', due: '2026-11-20', total: 4000 });
await doc('invoice', owes, { issue: '2026-10-21', due: '2026-11-21', total: 7777, status: 'draft' });
await db.query('INSERT INTO payments (account_id, document_id, amount, paid_on) VALUES (?, ?, 400, ?)', [account.id, settled, '2026-09-15']);
await A('POST', '/expenses', { businessId: biz.id, description: 'Rent', amount: 1500, incurredOn: '2026-10-05' });
const f = await monthFigures(account.id, '2026-11-01');
ok(f.month === 'October' && f.from === '2026-10-01' && f.to === '2026-10-31', 'it covers last month, first to last day', `${f.month} ${f.from} ${f.to}`);
ok(f.invoiced.ZAR === 7600, 'invoiced counts sent invoices raised that month, not drafts or old history', f.invoiced.ZAR);
ok(f.received.ZAR === 800 && f.receivedBefore.ZAR === 400, 'money in for the month, and the month before to compare', `${f.received.ZAR} ${f.receivedBefore.ZAR}`);
ok(f.spent.ZAR === 1500, 'spent includes expenses', f.spent.ZAR);
ok(f.owed.ZAR === 2500 + 300 + 999 + 4000 && f.oldOwed.ZAR === 999, 'owed is what is really owed, saying how much is old history', `${f.owed.ZAR} ${f.oldOwed.ZAR}`);
ok(f.topOwing[0]?.name === 'Client' && f.topOwing[0].amount === 2500, 'who owes most, late', JSON.stringify(f.topOwing));
ok(f.dueThisMonth.ZAR === 4000, 'and what falls due this month', f.dueThisMonth.ZAR);
ok((await runMonthReport('2026-11-02')).startsWith('Not the 1st'), 'the report only goes on the 1st');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
