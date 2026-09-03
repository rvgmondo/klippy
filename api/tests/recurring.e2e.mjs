/**
 * Costs that repeat.
 *
 * Expenses were one-off only, so rent, salaries, software and insurance had to be
 * retyped every month or they never appeared. Nobody does that twelve times a year,
 * which meant the cost side of every report was quietly understated and profit read
 * better than the bank did.
 *
 * The three things that can go wrong, and are pinned here:
 *   - a job that has not run for months SKIPS the missed ones instead of catching up,
 *     silently losing real spending
 *   - a job that runs twice writes the same month twice, inventing spending
 *   - a caught-up expense is dated when the job ran rather than when it was due, which
 *     puts it in the wrong month for both profit and VAT
 *
 * Run with a test server on 8095:  node tests/recurring.e2e.mjs
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://localhost:8095/api/v1';
const url = new URL(process.env.DATABASE_URL);
const db = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
});

let failures = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')])
  .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

const clean = async () => {
  await db.query("DELETE FROM expenses WHERE account_id = 1 AND description LIKE 'E2E-REC%'");
  await db.query("DELETE FROM recurring_expenses WHERE account_id = 1 AND description LIKE 'E2E-REC%'");
};
await clean();

const lr = await fetch(API + '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ruben@x.com', password: 'klippylook1' }),
});
const cookie = cookieOf(lr);
ok(lr.ok && !!cookie, 'owner signs in');
if (!cookie) { await db.end(); process.exit(1); }
const H = { 'content-type': 'application/json', cookie };

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const BID = biz.id;

const monthsAgo = (n) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
};

// ---- a cost entered late records the months it has already been running -----------
let RID;
{
  const started = monthsAgo(3);
  const res = await fetch(API + '/recurring-expenses', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      businessId: BID, description: 'E2E-REC Office rent', category: 'Premises',
      amount: 8500, intervalMonths: 1, startedOn: started,
    }),
  });
  ok(res.status === 201, 'a standing cost can be recorded', String(res.status));
  const body = await res.json();
  RID = body.id;

  // Started 3 months ago on the 1st: that month, plus the two since, plus this one.
  ok(body.recorded === 4,
    'and entering it late records every month it has already been running, not just today',
    body.recorded + ' months');

  // Formatted by the database, not by JavaScript. The driver hands a DATE back as a
  // Date at LOCAL midnight, so converting it to an ISO string in a timezone ahead of
  // UTC reads back a day early and the assertion would be testing the timezone.
  const [rows] = await db.query(
    "SELECT DATE_FORMAT(incurred_on, '%Y-%m-%d') d, amount FROM expenses WHERE recurring_expense_id = ? ORDER BY incurred_on", [RID]);
  ok(rows.length === 4, 'four expense rows exist', String(rows.length));
  const first = rows[0].d;
  ok(first === started,
    'dated when each was DUE, not when the job ran, so it lands in the right month and VAT period',
    first);
  ok(Number(rows[0].amount) === 8500, 'at the amount recorded', String(rows[0].amount));
}

// ---- running again writes nothing, however many times --------------------------------
{
  const { generateFor } = await import('file:///C:/CC/klippy-v2/api/dist/lib/recurringExpenses.js');
  const [[row]] = await db.query('SELECT * FROM recurring_expenses WHERE id = ?', [RID]);
  // camelCase the row the way Drizzle hands it over. The driver returns DATE columns
  // as JS Date objects here, while Drizzle is configured for string mode, so they are
  // formatted rather than stringified: String(new Date()) gives "Thu Oct 01", which is
  // not a date any database will take.
  const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const asRow = {
    id: row.id, businessId: row.business_id, description: row.description,
    category: row.category, amount: row.amount, vatAmount: row.vat_amount,
    intervalMonths: row.interval_months, nextDueOn: ymd(row.next_due_on),
    startedOn: ymd(row.started_on),
    endsOn: row.ends_on ? ymd(row.ends_on) : null,
    lastGeneratedOn: null, createdBy: row.created_by,
  };
  const again = await generateFor(1, asRow);
  ok(again.written === 0, 'running it again writes nothing', again.written + ' written');

  const [[n]] = await db.query('SELECT COUNT(*) n FROM expenses WHERE recurring_expense_id = ?', [RID]);
  ok(Number(n.n) === 4, 'so a job that runs twice cannot invent spending', String(n.n));
}

// ---- it reaches the reports, which is the entire point -------------------------------
{
  const from = monthsAgo(3);
  const to = new Date().toISOString().slice(0, 10);
  const rep = await fetch(API + `/reports/time?from=${from}&to=${to}&businessId=${BID}`, { headers: { cookie } })
    .then((r) => r.json());
  const spent = rep.totals?.expenses ?? 0;
  ok(spent >= 34000,
    'the standing cost shows up in the spending the reports read', String(spent));
}

// ---- a cost that ends stops, and what it already recorded is kept ---------------------
{
  const ended = await fetch(API + '/recurring-expenses/' + RID, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ endsOn: monthsAgo(1) }),
  });
  ok(ended.status === 200, 'a standing cost can be given an end date', String(ended.status));

  const stop = await fetch(API + '/recurring-expenses/' + RID, { method: 'DELETE', headers: { cookie } });
  ok(stop.status === 200, 'and can be stopped entirely', String(stop.status));

  // The expenses it wrote are real money that really left. Deleting them would rewrite
  // history and change a VAT return that may already have been filed.
  const [[n]] = await db.query(
    "SELECT COUNT(*) n FROM expenses WHERE account_id = 1 AND description = 'E2E-REC Office rent'");
  ok(Number(n.n) === 4, 'stopping it keeps the costs it already recorded', String(n.n));
}

// ---- a quarterly cost does not become a monthly one ----------------------------------
{
  const res = await fetch(API + '/recurring-expenses', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      businessId: BID, description: 'E2E-REC Accountant', amount: 3000,
      intervalMonths: 3, startedOn: monthsAgo(6),
    }),
  });
  const body = await res.json();
  // Six months back, quarterly: due at 6, 3 and 0 months ago.
  ok(body.recorded === 3, 'quarterly means quarterly, not monthly', body.recorded + ' recorded');
}

await clean();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
