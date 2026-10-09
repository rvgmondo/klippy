/**
 * The set-up check on the Automation panel.
 *
 * What would be quietly wrong: the background work (reminders, recurring invoices,
 * follow-ups, statements) doing nothing because a setting is missing or nothing
 * wakes the app, and no screen saying so.
 *
 * Run with a test server on 8095 (or set KLIPPY_API), started with CRON_SECRET.
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
const { setupChecks } = await import('file:///C:/CC/klippy-v2/api/dist/routes/cron.js');
const state = (checks, key) => checks.find((c) => c.key === key)?.state;

// ---- the wake-up cron is recorded when it knocks -------------------------------------------
const before = Date.now();
const tick = await fetch(API + '/cron/tick', { method: 'POST', headers: { 'X-Cron-Key': process.env.CRON_SECRET ?? 'e2e-cron-secret' } });
ok(tick.status === 200, 'the cron tick is accepted with the key', tick.status);
const [[row]] = await db.query("SELECT last_run_at a FROM job_runs WHERE name = 'cron-tick'");
ok(row && Date.parse(row.a.replace(' ', 'T') + 'Z') >= before - 5000, 'and the knock is written down', row?.a);
const bad = await fetch(API + '/cron/tick', { method: 'POST', headers: { 'X-Cron-Key': 'wrong' } });
ok(bad.status === 401, 'a wrong key is refused', bad.status);

// ---- what the check says -------------------------------------------------------------------------
const now = new Date();
const map = (rows) => new Map(rows.map((r) => [r.name, r]));
const fresh = setupChecks(map([{ name: 'cron-tick', lastRunAt: new Date(now.getTime() - 10 * 60000) }]));
ok(state(fresh, 'cron') === 'ok', 'a knock ten minutes ago reads as working');
const stale = setupChecks(map([{ name: 'cron-tick', lastRunAt: new Date(now.getTime() - 5 * 3600000) }]));
ok(state(stale, 'cron') === 'warn' && /5 hours/.test(stale.find((c) => c.key === 'cron').detail), 'five hours ago is a warning that says how long');
ok(state(setupChecks(new Map()), 'cron') === 'bad', 'never knocked is a problem, with the fix');
const failed = setupChecks(map([{ name: 'invoice-reminders', lastStatus: 'failed', enabled: true }]));
ok(state(failed, 'failed') === 'bad' && /Payment reminders/.test(failed.find((c) => c.key === 'failed').detail), 'a failed job is named');
const text = JSON.stringify(setupChecks(new Map()));
ok(!text.includes(process.env.CRON_SECRET ?? 'e2e-cron-secret') && !(process.env.PAYMENTS_SECRET && text.includes(process.env.PAYMENTS_SECRET)), 'no secret value is ever in what the check says');

// ---- only the operator sees it --------------------------------------------------------------------
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
const tag = Date.now();
const r = await fetch(API + '/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'setupcheck1234', accountName: `Check ${tag}`, name: 'Che Ck', email: `check.${tag}@test.local`, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
});
const res = await fetch(API + '/automation', { headers: { cookie: cookieOf(r) } });
ok(res.status === 403, 'a customer cannot read the platform set-up', res.status);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
