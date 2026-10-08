/**
 * Home, Four squares and the command bar with old-system history in the workspace.
 *
 * Each block names what would be quietly wrong:
 *   - dozens of old-system invoices burying today's real work on Home
 *   - Four squares filling all ten slots with them, so a current late invoice never shows
 *   - "sent N repeating invoices by itself" counting drafts nobody sent
 *   - your own Outlook meetings missing from Home, or showing on someone else's
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
    body: JSON.stringify({ password: 'homehistory12', accountName: `Home ${tag}`, name: 'Ho Me', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  const cookie = cookieOf(r);
  const body = await r.json();
  const A = async (method, p, b) => {
    const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { A, account: body.account, user: body.user };
};
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = day(0);

const { A, account, user } = await signup(`home.${tag}@test.local`);
const biz = (await A('GET', '/businesses')).body.businesses[0];
const insert = async (seq, due, status = 'sent', extra = {}) => {
  const [r] = await db.query(`INSERT INTO documents (account_id, business_id, type, seq, number, client_name, issue_date, due_date, status, total, subtotal, subscription_id)
    VALUES (?, ?, 'invoice', ?, ?, 'Someone', ?, ?, ?, 100, 100, ?)`,
  [account.id, biz.id, seq, `X-${seq}`, day(-400), due, status, extra.sub ?? null]);
  return r.insertId;
};
// Twelve ancient invoices from the old system, two old drafts, and one real late invoice.
for (let i = 0; i < 12; i++) await insert(3_000_000_000 + i, day(-300 - i));
await insert(3_000_000_100, null, 'draft');
await insert(3_000_000_101, null, 'draft');
const real = await insert(42, day(-5));

// ---- Home -----------------------------------------------------------------------------------
const home = (await A('GET', '/home')).body;
const late = home.items.filter((i) => i.kind === 'invoice-late');
ok(late.length === 1 && late[0].docId === real, 'only the real late invoice is its own row on Home', late.length);
const old = home.items.find((i) => i.kind === 'old-unpaid');
ok(old?.count === 12 && old.amount === 1200 && old.group === 'overdue', 'the old ones are one summary row, with what they add up to', JSON.stringify(old));
const lastOverdue = home.items.filter((i) => i.group === 'overdue').at(-1);
ok(lastOverdue?.kind === 'old-unpaid', 'and it sits below the real overdue work, never above it');
ok(home.items.find((i) => i.kind === 'old-drafts')?.count === 2 && !home.items.some((i) => i.kind === 'draft'), 'old drafts are one row too, not two "nobody has seen" drafts');
ok(home.figures.owed.ZAR === 1300 && home.figures.oldOwed.ZAR === 1200, 'what is owed still counts them, and says how much is history', JSON.stringify(home.figures));

// ---- Four squares and the command bar ----------------------------------------------------------
const focus = (await A('GET', '/focus')).body;
const focusText = JSON.stringify(focus);
ok(focusText.includes('X-42') && !focusText.includes('X-3000000000'), 'Four squares shows the real late invoice, not the old ones', focusText.length);
const cmd = (await A('GET', '/command-centre')).body;
const cmdText = JSON.stringify(cmd);
ok(!cmdText.includes('X-3000000000'), 'the command bar does not offer old-system invoices for chasing');

// ---- what Klippy did by itself ---------------------------------------------------------------------
const off = (await A('POST', '/offerings', { businessId: biz.id, name: 'Care', price: 100, recurring: true })).body.offering.id;
const folder = (await A('POST', '/folders', { name: 'Repeat Client', businessId: biz.id })).body.folder.id;
const sub = (await A('POST', '/subscriptions', { businessId: biz.id, offeringId: off, folderId: folder })).body.subscription.id;
const [[firstLine]] = await db.query('SELECT l.description d FROM document_lines l JOIN documents x ON x.id = l.document_id WHERE x.subscription_id = ?', [sub]);
ok(/^Care, \d+ \w{3}( \d{4})? to \d+ \w{3} \d{4}$/.test(firstLine?.d ?? ''), 'a subscription invoice says which period it pays for', firstLine?.d);
await db.query("UPDATE documents SET status = 'draft', issue_date = ? WHERE subscription_id = ?", [today, sub]);
await insert(500, day(10), 'draft', { sub });
let did = (await A('GET', '/home')).body.didForYou;
ok(did.autoInvoices === 0, 'repeating invoices still in draft are not "sent by itself"', did.autoInvoices);
await insert(501, day(10), 'sent', { sub });
await db.query('UPDATE documents SET issue_date = ? WHERE seq = 501 AND account_id = ?', [today, account.id]);
did = (await A('GET', '/home')).body.didForYou;
ok(did.autoInvoices === 1, 'one that went out is', did.autoInvoices);

// ---- your own calendar ------------------------------------------------------------------------------
const { encryptSecret } = await import('file:///C:/CC/klippy-v2/api/dist/lib/secretbox.js');
const [f] = await db.query(`INSERT INTO calendar_feeds (account_id, user_id, name, url_enc, url_host, last_synced_at, event_count)
  VALUES (?, ?, 'Outlook', ?, 'outlook.office365.com', UTC_TIMESTAMP(), 1)`, [account.id, user.id, encryptSecret('https://outlook.office365.com/x.ics')]);
await db.query(`INSERT INTO external_events (account_id, feed_id, user_id, uid, title, start_at, end_at, all_day) VALUES (?, ?, ?, 'h1', 'Dentist', ?, ?, 0)`,
  [account.id, f.insertId, user.id, `${today} 23:00:00`, `${today} 23:30:00`]);
const withCal = (await A('GET', '/home')).body.items.find((i) => i.title === 'Dentist');
ok(withCal?.external === true && withCal.kind === 'event', 'your own calendar\'s meetings show on Home, marked as yours', JSON.stringify(withCal));
const { A: B } = await signup(`home.other.${tag}@test.local`);
ok(!((await B('GET', '/home')).body.items ?? []).some((i) => i.title === 'Dentist'), 'and on nobody else\'s');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
