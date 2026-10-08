/**
 * Your own calendar (Outlook, Google, Apple), read into Klippy.
 *
 * Runs without the internet: the calendar and its events are written straight to
 * the database, so this checks what Klippy does with them, not Google's servers.
 * The reader itself is covered by tests/ics.test.ts.
 *
 * Each block names what would be quietly wrong:
 *   - your meetings showing to anyone else, in or out of your workspace
 *   - Today's plan ignoring them
 *   - a link to the server's own network, or plain http, being fetched
 *   - the private link ever being sent back to the browser
 *   - someone else refreshing or removing your calendar
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
  database: url.pathname.slice(1),
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
    body: JSON.stringify({ password: 'outsidepass12', accountName: `Cal ${tag}`, name: 'Cal User', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  const cookie = cookieOf(r);
  const body = await r.json();
  const A = async (method, p, b) => {
    const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { A, account: body.account, user: body.user };
};

const { A, account, user } = await signup(`cal.${tag}@test.local`);
const { encryptSecret } = await import('file:///C:/CC/klippy-v2/api/dist/lib/secretbox.js');

// A calendar read a moment ago (so nothing tries to fetch the made-up link), with
// a meeting today at 10:00 UTC for an hour, and an all-day event tomorrow.
const [ins] = await db.query(`INSERT INTO calendar_feeds (account_id, user_id, name, url_enc, url_host, last_synced_at, event_count)
  VALUES (?, ?, 'Outlook', ?, 'outlook.office365.com', UTC_TIMESTAMP(), 2)`,
[account.id, user.id, encryptSecret('https://outlook.office365.com/owa/calendar/secret-token/calendar.ics')]);
const feedId = ins.insertId;
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
await db.query(`INSERT INTO external_events (account_id, feed_id, user_id, uid, title, location, start_at, end_at, all_day) VALUES
  (?, ?, ?, 'm1', 'Client call', 'Teams', ?, ?, 0),
  (?, ?, ?, 'h1', 'Public holiday', NULL, ?, ?, 1)`,
[account.id, feedId, user.id, `${today} 10:00:00`, `${today} 11:00:00`, account.id, feedId, user.id, `${tomorrow} 00:00:00`, `${tomorrow} 23:59:59`]);

// ---- you see them ------------------------------------------------------------------
const feeds = (await A('GET', '/calendar-feeds')).body.feeds ?? [];
ok(feeds.length === 1 && feeds[0].host === 'outlook.office365.com', 'your calendar is listed by its host', feeds[0]?.host);
ok(!JSON.stringify(feeds).includes('secret-token'), 'the private link is never sent back to the browser');
const evs = (await A('GET', `/external-events?from=${today}&to=${tomorrow}`)).body.events ?? [];
ok(evs.some((e) => e.title === 'Client call') && evs.some((e) => e.title === 'Public holiday' && e.allDay), 'its meetings come back for the calendar', evs.map((e) => e.title).join(', '));

// ---- Today plans around them ----------------------------------------------------------
const day = (await A('GET', `/tasks/day?date=${today}`)).body;
const m = day.meetings?.find((x) => x.title === 'Client call');
ok(!!m && m.external === true && m.minutes === 60, 'Today puts the meeting on the plan as an hour, marked as yours', JSON.stringify(m));
ok(day.capacity?.meetingMinutes >= 60, 'and counts it against the day', day.capacity?.meetingMinutes);

// ---- nobody else sees them --------------------------------------------------------------
const { A: B } = await signup(`cal.other.${tag}@test.local`);
ok(((await B('GET', `/external-events?from=${today}&to=${tomorrow}`)).body.events ?? []).length === 0, 'another workspace sees none of your meetings');
ok(((await B('GET', '/calendar-feeds')).body.feeds ?? []).length === 0, 'or your calendar');
ok((await B('POST', `/calendar-feeds/${feedId}/refresh`)).status === 404, 'cannot refresh it');
ok((await B('DELETE', `/calendar-feeds/${feedId}`)).status === 404, 'or remove it');
const otherDay = (await B('GET', `/tasks/day?date=${today}`)).body;
ok(!(otherDay.meetings ?? []).some((x) => x.title === 'Client call'), "and it is not on anyone else's Today");

// ---- links that must never be fetched ------------------------------------------------------
for (const [label, link] of [
  ['plain http', 'http://example.com/cal.ics'],
  ['the server itself', 'https://127.0.0.1/cal.ics'],
  ['localhost', 'https://localhost/cal.ics'],
  ['a private network', 'https://10.0.0.5/cal.ics'],
  ['cloud metadata', 'https://169.254.169.254/latest/meta-data'],
  ['a password in the link', 'https://user:pass@example.com/cal.ics'],
]) {
  const r = await A('POST', '/calendar-feeds', { url: link });
  ok(r.status === 400, `refuses ${label}`, r.body.error);
}

// ---- removing it ------------------------------------------------------------------------------
ok((await A('DELETE', `/calendar-feeds/${feedId}`)).status === 200, 'you can remove it');
const [[{ n }]] = await db.query('SELECT COUNT(*) n FROM external_events WHERE feed_id = ?', [feedId]);
ok(Number(n) === 0, 'and its meetings go with it', n);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
