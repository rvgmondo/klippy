/**
 * Seeing and steering reminders: when the last one went, when the next one goes,
 * and pausing, resuming or moving it.
 *
 * Each block names what would be quietly wrong:
 *   - the "next reminder" shown is the date the daily run actually sends on
 *   - a paused invoice, or a paused client, is not chased by the run or by Chase all
 *   - a date moved by hand is used once, then the schedule carries on
 *   - every send is written down: automatic, final notice and by hand
 *   - Chase on one invoice still goes when it is paused (a deliberate act)
 *   - nobody else can see or change any of it
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
    body: JSON.stringify({ password: 'remindpass123', accountName: `Remind ${tag}`, name: 'Rae Remind', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  const cookie = cookieOf(r);
  const account = (await r.json()).account;
  const A = async (method, p, b) => {
    const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { A, account };
};
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = day(0);

const { A, account } = await signup(`remind.${tag}@test.local`);
const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = ?', [account.id]);
await db.query('UPDATE businesses SET reminders_enabled = 1, reminder_offsets = ?, suspend_after_days = NULL WHERE id = ?', [JSON.stringify([-3, 0, 7]), biz.id]);
const mkClient = async (name) => (await A('POST', '/folders', { name, businessId: biz.id, billingEmail: `${name.replace(/\W/g, '').toLowerCase()}.${tag}@test.local` })).body.folder.id;
const acme = await mkClient('Acme Remind');
const beta = await mkClient('Beta Remind');
let seq = 7000;
const invoice = async (folder, due, extra = {}) => {
  seq++;
  const [r] = await db.query(`INSERT INTO documents (account_id, business_id, type, seq, number, folder_id, client_name, issue_date, due_date, status, total, subtotal, last_reminder_on)
    VALUES (?, ?, 'invoice', ?, ?, ?, 'Client', ?, ?, 'sent', 500, 500, ?)`, [account.id, biz.id, seq, `INV-${seq}`, folder, day(-30), due, extra.last ?? null]);
  return r.insertId;
};
const { runInvoiceReminders } = await import('file:///C:/CC/klippy-v2/api/dist/lib/jobs.js');
const doc = async (id) => (await db.query('SELECT last_reminder_on l, next_reminder_on n, reminders_paused p, suspended_at s FROM documents WHERE id = ?', [id]))[0][0];

// ---- what the screen says is what the run does --------------------------------------
const soon = await invoice(acme, day(5));
let st = (await A('GET', `/documents/${soon}/reminders`)).body;
ok(st.plan?.next === day(2) && st.plan.kind === 'reminder', 'due in 5 days on a -3/0/7 schedule: next reminder in 2 days', st.plan?.next);
ok(st.history?.length === 0 && st.lastReminderOn === null, 'and none sent yet');
await runInvoiceReminders();
ok(!(await doc(soon)).l, 'the run does not send before that date');

const dueToday = await invoice(acme, today);
st = (await A('GET', `/documents/${dueToday}/reminders`)).body;
ok(st.plan.next === today, 'due today: the next reminder is today', st.plan.next);
await runInvoiceReminders();
ok((await doc(dueToday)).l === today, 'and the run sends it today');
st = (await A('GET', `/documents/${dueToday}/reminders`)).body;
ok(st.history.length === 1 && st.history[0].kind === 'reminder' && st.history[0].channels.includes('email'), 'it is written down, with how it went', JSON.stringify(st.history[0]));
ok(st.plan.next === day(7), 'and the next one is a week after due', st.plan.next);

// ---- pause and resume --------------------------------------------------------------------
const late = await invoice(acme, day(-7));
const paused = (await A('PATCH', `/documents/${late}/reminders`, { paused: true })).body;
ok(paused.plan?.next === null && /Paused for this invoice/.test(paused.plan.reason), 'paused: nothing is coming, and it says why', paused.plan?.reason);
await runInvoiceReminders();
ok(!(await doc(late)).l, 'the run skips a paused invoice');
const bulk = (await A('POST', '/collections/chase', { ids: [late] })).body;
ok(bulk.sent === 0 && bulk.paused === 1, 'Chase all skips it too', JSON.stringify(bulk));
const forced = (await A('POST', '/collections/chase', { ids: [late], force: true })).body;
ok(forced.sent === 1, 'Chase on that one invoice still sends', JSON.stringify(forced));
st = (await A('GET', `/documents/${late}/reminders`)).body;
ok(st.history[0]?.kind === 'chase' && st.history[0]?.by === 'Rae Remind', 'a chase by hand is written down with who did it', st.history[0]?.by);
const resumed = (await A('PATCH', `/documents/${late}/reminders`, { paused: false })).body;
ok(resumed.paused === false && resumed.plan.next === null && /No more reminders/.test(resumed.plan.reason), 'resumed: the schedule is used up, and it says so', resumed.plan.reason);

// ---- moving the next one -------------------------------------------------------------------
const moved = (await A('PATCH', `/documents/${late}/reminders`, { nextReminderOn: day(3) })).body;
ok(moved.plan.next === day(3) && moved.plan.moved, 'a date chosen by hand is the next reminder', moved.plan.next);
ok((await A('PATCH', `/documents/${late}/reminders`, { nextReminderOn: day(-1) })).status === 400, 'a date in the past is refused');
await db.query('UPDATE documents SET next_reminder_on = ?, last_reminder_on = ? WHERE id = ?', [today, day(-1), late]);
await runInvoiceReminders();
const afterMove = await doc(late);
ok(afterMove.l === today && afterMove.n === null, 'on that day it goes, and the hand-picked date is used once', `${afterMove.l}, ${afterMove.n}`);

// ---- a paused client -----------------------------------------------------------------------
const betaInv = await invoice(beta, today);
ok((await A('PATCH', `/clients/${beta}/reminders`, { paused: true })).status === 200, 'a client can be paused');
st = (await A('GET', `/documents/${betaInv}/reminders`)).body;
ok(st.clientPaused && /Paused for this client/.test(st.plan.reason), 'their invoices say so', st.plan.reason);
await runInvoiceReminders();
ok(!(await doc(betaInv)).l, 'and the run does not chase them');
const page = (await A('GET', `/clients/${beta}`)).body;
ok(page.client?.remindersPaused === true, 'the client page knows');
await A('PATCH', `/clients/${beta}/reminders`, { paused: false });

// ---- the final notice --------------------------------------------------------------------------
await db.query('UPDATE businesses SET suspend_after_days = 10 WHERE id = ?', [biz.id]);
const veryLate = await invoice(acme, day(-15), { last: day(-8) });
st = (await A('GET', `/documents/${veryLate}/reminders`)).body;
ok(st.plan.next === today && st.plan.kind === 'final', 'past the at-risk line: the final notice is next, today', `${st.plan.next} ${st.plan.kind}`);
await runInvoiceReminders();
const fin = await doc(veryLate);
st = (await A('GET', `/documents/${veryLate}/reminders`)).body;
ok(fin.s && st.history[0]?.kind === 'final', 'it goes, is flagged, and is written down as the final notice');

// ---- the Owed to you list --------------------------------------------------------------------
const coll = (await A('GET', '/collections')).body;
const lateRow = JSON.stringify(coll).includes('"nextReminder"');
ok(lateRow, 'the Owed to you list carries the next reminder for each invoice');

// ---- nobody else --------------------------------------------------------------------------------
const { A: B } = await signup(`remind.other.${tag}@test.local`);
ok((await B('GET', `/documents/${late}/reminders`)).status === 404, 'another workspace cannot see the reminders');
ok((await B('PATCH', `/documents/${late}/reminders`, { paused: true })).status === 404, 'or pause them');
ok((await B('PATCH', `/clients/${acme}/reminders`, { paused: true })).status === 404, 'or pause a client');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
