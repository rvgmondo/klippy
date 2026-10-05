/**
 * Subscription settings, against a real database.
 *
 * Each block names what would be quietly wrong:
 *   - a moved bill date sticks: the next cycle bills on the new day, not the old one
 *   - a date in the past is refused (the next run would bill it at once)
 *   - Bill now raises one invoice and moves the date one cycle; two clicks at once
 *     never bill the same month twice
 *   - a fixed-term subscription stops at its end date and says so
 *   - resuming after a long pause carries on from today instead of billing every
 *     missed month, one per morning
 *   - the screen's list carries the new fields, and nobody else can change one
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
const call = (cookie) => async (method, p, b) => {
  const r = await fetch(API + p, {
    method, headers: { ...(b !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: cookieOf(r) };
};
const signup = async (email) => {
  const r = await call('')('POST', '/auth/signup', { password: 'subspass12345', accountName: `Subs ${tag}`, name: 'Sam Subs', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false });
  return { A: call(r.cookie), account: r.body.account };
};
const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const today = day(0);
const subRow = async (id) => (await db.query('SELECT * FROM subscriptions WHERE id = ?', [id]))[0][0];
const invoiceCount = async (id) => Number((await db.query('SELECT COUNT(*) n FROM documents WHERE subscription_id = ?', [id]))[0][0].n);

const { A, account } = await signup(`subs.${tag}@test.local`);
const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = ?', [account.id]);
const client = (await A('POST', '/folders', { name: 'Monthly Client', businessId: biz.id, billingEmail: `mc.${tag}@test.local` })).body.folder.id;
const hosting = (await A('POST', '/offerings', { businessId: biz.id, name: 'Hosting', price: 250, recurring: true, unit: 'month' })).body.offering?.id;
ok(!!hosting, 'a monthly plan on the price list');

const start = async (startedOn) => (await A('POST', '/subscriptions', { businessId: biz.id, offeringId: hosting, folderId: client, startedOn })).body.subscription;
const { runSubscriptionBilling } = await import('file:///C:/CC/klippy-v2/api/dist/lib/jobs.js');

// ---- moving the bill date sticks ------------------------------------------------------
// Started on the 5th, then moved to the 25th.
const s1 = await start(`${today.slice(0, 7)}-05`);
const target = (() => { const d = new Date(`${day(40)}T00:00:00Z`); d.setUTCDate(25); return iso(d); })();
const moved = await A('PATCH', `/subscriptions/${s1.id}`, { nextBillDate: target });
let r1 = await subRow(s1.id);
ok(moved.status === 200 && r1.next_bill_date === target && r1.billing_day === 25, 'moving the date sets the billing day to match', `${r1.next_bill_date}, day ${r1.billing_day}`);
// Pretend that day has come, and run the billing.
await db.query('UPDATE subscriptions SET next_bill_date = ? WHERE id = ?', [today, s1.id]);
const before1 = await invoiceCount(s1.id);
await runSubscriptionBilling();
r1 = await subRow(s1.id);
ok(await invoiceCount(s1.id) === before1 + 1, 'the run bills it once');
ok(r1.next_bill_date.endsWith('-25') || Number(r1.next_bill_date.slice(8)) >= 28, 'and the next one is on the 25th, not back on the 5th', r1.next_bill_date);
const list = (await A('GET', '/subscriptions')).body.subscriptions.find((s) => s.id === s1.id);
ok(list?.billsOnDay === 25 && list?.billingDay === 25, 'the list says which day it bills on', list?.billsOnDay);
const detail = (await A('GET', `/subscriptions/${s1.id}`)).body;
ok(detail.upcoming?.length === 6 && detail.upcoming.every((d) => d.endsWith('-25') || Number(d.slice(8)) >= 28), 'the coming dates are all on the 25th', detail.upcoming?.join(' '));
ok(detail.invoices?.length >= 2, 'and it lists the invoices it has made', detail.invoices?.length);

const past = await A('PATCH', `/subscriptions/${s1.id}`, { nextBillDate: day(-3) });
ok(past.status === 400, 'a date in the past is refused', past.status);

// ---- other settings ----------------------------------------------------------------------
const set = await A('PATCH', `/subscriptions/${s1.id}`, { intervalMonths: 3, price: 600, notes: '  Agreed in the June call  ', billingDay: 1 });
r1 = await subRow(s1.id);
ok(set.status === 200 && r1.interval_months === 3 && Number(r1.price) === 600 && r1.notes === 'Agreed in the June call' && r1.billing_day === 1,
  'how often, price, notes and the billing day can all be changed', `${r1.interval_months}, ${r1.price}, ${r1.billing_day}`);
const badEnd = await A('PATCH', `/subscriptions/${s1.id}`, { endsOn: '2000-01-01' });
ok(badEnd.status === 400, 'it cannot end before it started', badEnd.status);
const otherBiz = (await A('POST', '/businesses', { name: `Other ${tag}`, type: 'services' })).body.business?.id;
const otherPlan = otherBiz ? (await A('POST', '/offerings', { businessId: otherBiz, name: 'Other plan', price: 99, recurring: true })).body.offering?.id : null;
if (otherPlan) {
  const wrong = await A('PATCH', `/subscriptions/${s1.id}`, { offeringId: otherPlan });
  ok(wrong.status === 400, "a plan from another business's price list is refused", wrong.status);
}

// ---- Bill now ------------------------------------------------------------------------------
const s2 = await start(today);
// Its first invoice was made when it started; pretend that was an hour ago.
await db.query('UPDATE subscriptions SET last_billed_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?', [s2.id]);
const r2 = await subRow(s2.id);
const before2 = await invoiceCount(s2.id);
const [a, b] = await Promise.all([A('POST', `/subscriptions/${s2.id}/bill-now`), A('POST', `/subscriptions/${s2.id}/bill-now`)]);
const after2 = await subRow(s2.id);
ok([a.status, b.status].sort().join(',') === '200,409', 'two Bill now clicks at once bill once', `${a.status}, ${b.status}`);
ok(await invoiceCount(s2.id) === before2 + 1, 'exactly one invoice was made');
const again = await A('POST', `/subscriptions/${s2.id}/bill-now`);
ok(again.status === 409 && await invoiceCount(s2.id) === before2 + 1, 'a second click a moment later does not bill next month too', again.status);
ok(after2.next_bill_date > r2.next_bill_date, 'and the next date moved on one cycle', `${r2.next_bill_date} to ${after2.next_bill_date}`);
await A('PATCH', `/subscriptions/${s2.id}`, { status: 'paused' });
const pausedBill = await A('POST', `/subscriptions/${s2.id}/bill-now`);
ok(pausedBill.status === 400, 'a paused one cannot be billed now', pausedBill.status);

// ---- resuming after a long pause ----------------------------------------------------------
await db.query('UPDATE subscriptions SET next_bill_date = ? WHERE id = ?', [day(-100), s2.id]);
await A('PATCH', `/subscriptions/${s2.id}`, { status: 'active' });
const resumed = await subRow(s2.id);
ok(resumed.status === 'active' && resumed.next_bill_date >= today, 'resuming carries on from today, not three months back', resumed.next_bill_date);
const before3 = await invoiceCount(s2.id);
await runSubscriptionBilling();
const billedOnResume = (await invoiceCount(s2.id)) - before3;
ok(billedOnResume <= 1, 'so the next run bills at most this cycle', billedOnResume);

// ---- a fixed term ---------------------------------------------------------------------------
const s3 = await start(day(-60));
ok(s3.nextBillDate > today, 'a subscription started in the past does not leave its next bill in the past', s3.nextBillDate);
await A('PATCH', `/subscriptions/${s3.id}`, { endsOn: day(-1) });
await db.query('UPDATE subscriptions SET next_bill_date = ? WHERE id = ?', [today, s3.id]);
const before4 = await invoiceCount(s3.id);
await runSubscriptionBilling();
const r3 = await subRow(s3.id);
ok(r3.status === 'canceled' && await invoiceCount(s3.id) === before4, 'past its end date it stops and bills nothing', r3.status);
const endedNow = await A('POST', `/subscriptions/${s3.id}/bill-now`);
ok(endedNow.status === 400, 'and cannot be billed by hand either', endedNow.status);

// ---- nobody else ------------------------------------------------------------------------------
const { A: B } = await signup(`subs.other.${tag}@test.local`);
ok((await B('PATCH', `/subscriptions/${s1.id}`, { nextBillDate: day(10) })).status === 404, 'another workspace cannot change one');
ok((await B('POST', `/subscriptions/${s1.id}/bill-now`)).status === 404, 'or bill it');
ok((await B('GET', `/subscriptions/${s1.id}`)).status === 404, 'or read it');

// ---- in the backup ---------------------------------------------------------------------------
const exp = (await A('GET', '/account/export')).body;
const data = exp.data ?? exp;
const ex = data.subscriptions?.find((s) => s.id === s1.id);
ok(ex?.billingDay === 1 && ex?.notes === 'Agreed in the June call', 'the backup keeps the billing day and notes', JSON.stringify({ d: ex?.billingDay }));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
