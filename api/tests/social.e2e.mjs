/**
 * Klippy Social, phase 2: plan, schedule and hand over.
 *
 * What this proves, in the order it matters:
 *
 *   1. MANUAL DELIVERY WORKS WITH NOTHING CONNECTED. That is the whole claim of this
 *      phase: a post can name Instagram, Facebook and LinkedIn, reach its scheduled
 *      minute, and be handed to a person to put up, with no OAuth app, no platform
 *      approval and no adapter in existence. social_post_targets.social_account_id is
 *      nullable precisely so this is possible.
 *   2. THE PUBLISHER NEVER PUBLISHES TWICE. The claim is a conditional UPDATE, so a
 *      second run in the same minute must take nothing, however often it is called.
 *   3. VALIDATION REFUSES BEFORE SCHEDULING, NOT AT 09:00. Instagram with no media,
 *      an over-long caption, a one-item carousel: each is refused with the reason,
 *      against the field that caused it.
 *   4. THE PUBLIC MEDIA URL IS THE CREDENTIAL. It serves the file with no session,
 *      supports Range for video, and a wrong token is a 404 rather than a hint.
 *
 * A NOTE ON TIME, because it cost an hour to find. Drizzle stores datetimes as UTC
 * and reads them back as UTC, so the application is self-consistent. But the database
 * session timezone is SYSTEM, so raw SQL NOW() returns LOCAL time, two hours ahead
 * here. Any raw statement in a test that has to line up with a Drizzle-written column
 * must use UTC_TIMESTAMP(), and any raw SELECT of one must go through DATE_FORMAT
 * rather than letting the driver hand back a Date it has parsed as local.
 *
 * Run with a test server on 8095 started with CRON_SECRET and AUTH_RATE_LIMIT_MAX set.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://localhost:8095/api/v1';
const CRON_KEY = 'e2e-cron-secret';
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
  await db.query("DELETE FROM social_posts WHERE account_id = 1 AND title LIKE 'E2E-SOC%'");
  await db.query("DELETE FROM storage_nodes WHERE account_id = 1 AND name LIKE 'e2e-soc%'");
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
const post = (p, b) => fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const patch = (p, b) => fetch(API + p, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) });
const getj = (p) => fetch(API + p, { headers: { cookie } }).then((r) => r.json());

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const BID = biz.id;

// ---- nothing is connected, and every network is still offerable --------------------
{
  const a = await getj('/social/accounts');
  ok(Array.isArray(a.networks) && a.networks.length === 3,
    'all three networks are listed even with nothing connected', (a.networks || []).length + ' networks');
  ok(a.networks.every((n) => n.connected === false && n.canAutoPublish === false),
    'and each is honestly marked as not connected and not auto-publishable');
  ok(a.accounts.length === 0, 'with no connected accounts yet');
}

// ---- a post can target all three networks with no accounts at all ------------------
let PID;
{
  const res = await post('/social/posts', {
    businessId: BID, title: 'E2E-SOC Manual delivery',
    caption: 'Spring is here, and so is iced season.',
    firstComment: 'Open until 5 every day.',
    deliveryMode: 'manual',
    networks: ['instagram', 'facebook', 'linkedin'],
  });
  ok(res.status === 201, 'a post is created', String(res.status));
  PID = (await res.json()).id;

  const [rows] = await db.query(
    'SELECT network, social_account_id FROM social_post_targets WHERE post_id = ? ORDER BY network', [PID]);
  ok(rows.length === 3, 'with a target row per network', rows.length + ' targets');
  ok(rows.every((r) => r.social_account_id === null),
    'each with NO connected account, which is what makes manual delivery possible before any OAuth exists');
}

// ---- validation refuses before scheduling, with reasons ----------------------------
{
  // Instagram cannot post words alone, and this post has no media yet.
  const sched = await post(`/social/posts/${PID}/schedule`, {
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  ok(sched.status === 400, 'scheduling is refused while Instagram has no photo', String(sched.status));
  const body = await sched.json();
  const igMedia = (body.issues || []).find((i) => i.network === 'instagram' && i.field === 'media');
  ok(!!igMedia, 'and the reason names the network and the field', igMedia && igMedia.message.slice(0, 60));
  ok(!!igMedia?.rule, 'and cites the API-NOTES rule it comes from', igMedia && igMedia.rule);

  // A caption over Instagram's limit is refused too, and says by how much.
  await patch(`/social/posts/${PID}`, { caption: 'x'.repeat(2400) });
  const check = await post(`/social/posts/${PID}/check`).then((r) => r.json());
  const tooLong = (check.issues || []).find((i) => i.network === 'instagram' && i.field === 'caption');
  ok(!!tooLong && /2200/.test(tooLong.message), 'an over-long caption is caught with the real limit', tooLong && tooLong.message.slice(0, 70));
  const liLong = (check.issues || []).find((i) => i.network === 'linkedin' && i.field === 'caption');
  ok(!liLong, 'while the same caption is fine for LinkedIn, whose limit is higher');
  await patch(`/social/posts/${PID}`, { caption: 'Spring is here, and so is iced season.' });
}

// ---- media: upload, public URL, Range, and the token as the credential -------------
let TOKEN;
{
  // A one-pixel JPEG, so the upload is a real multipart request with real bytes.
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64');
  const form = new FormData();
  form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'e2e-soc-photo.jpg');
  const up = await fetch(API + `/social/posts/${PID}/media?width=1080&height=1080`, {
    method: 'POST', headers: { cookie }, body: form,
  });
  ok(up.status === 201, 'a photo uploads to the post', String(up.status));
  const upBody = await up.json();
  ok(Array.isArray(upBody.media) && upBody.media.length === 1, 'and comes back on the post');

  const [[m]] = await db.query('SELECT public_token, mime_type FROM social_post_media WHERE post_id = ?', [PID]);
  TOKEN = m.public_token;
  ok(/^[a-f0-9]{64}$/.test(TOKEN), 'with a 32-byte random public token', TOKEN.slice(0, 12) + '...');

  // The whole point: fetched with NO session at all, the way Meta fetches it.
  const pub = await fetch(`http://localhost:8095/api/v1/m/${TOKEN}.jpg`);
  ok(pub.status === 200, 'the public media URL serves the file with no session', String(pub.status));
  ok(pub.headers.get('content-type') === 'image/jpeg', 'with the right content type', pub.headers.get('content-type'));
  ok(pub.headers.get('accept-ranges') === 'bytes', 'and advertises Range support, which video players need');
  ok(/max-age=86400/.test(pub.headers.get('cache-control') || ''), 'and is cacheable for a day');

  const ranged = await fetch(`http://localhost:8095/api/v1/m/${TOKEN}.jpg`, { headers: { Range: 'bytes=0-9' } });
  ok(ranged.status === 206, 'a Range request gets a 206, not the whole file', String(ranged.status));
  ok((await ranged.arrayBuffer()).byteLength === 10, 'of exactly the bytes asked for');

  const wrong = await fetch(`http://localhost:8095/api/v1/m/${'0'.repeat(64)}.jpg`);
  ok(wrong.status === 404, 'a wrong token is a plain 404, with nothing to enumerate', String(wrong.status));
}

// ---- the carousel rule the docs corrected ------------------------------------------
{
  await patch(`/social/posts/${PID}`, { postType: 'carousel' });
  const check = await post(`/social/posts/${PID}/check`).then((r) => r.json());
  const carousel = (check.issues || []).find((i) => i.network === 'instagram' && /carousel/i.test(i.message));
  ok(!!carousel, 'a one-item carousel is refused, which the docs pin at 2 to 10', carousel && carousel.message.slice(0, 60));
  await patch(`/social/posts/${PID}`, { postType: 'post' });
}

// ---- scheduling, then the minute arriving -------------------------------------------
{
  const sched = await post(`/social/posts/${PID}/schedule`, {
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  ok(sched.status === 200, 'with a photo attached it schedules', String(sched.status));
  const [[p]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [PID]);
  ok(p.status === 'scheduled', 'and the post is scheduled', p.status);

  // Nothing is due yet, so a run must take nothing.
  const early = await fetch(API + '/cron/social-publish', {
    method: 'POST', headers: { 'X-Cron-Key': CRON_KEY },
  }).then((r) => r.json());
  ok(early.claimed === 0, 'a run before the time claims nothing', String(early.claimed));

  // Move it into the past, which is what the passing of a minute looks like.
  await db.query('UPDATE social_posts SET scheduled_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [PID]);
  const run = await fetch(API + '/cron/social-publish', {
    method: 'POST', headers: { 'X-Cron-Key': CRON_KEY },
  }).then((r) => r.json());
  ok(run.claimed === 1 && run.manual === 1, 'the due post is claimed and handed over to be posted by hand',
    `claimed ${run.claimed}, manual ${run.manual}`);

  const [[after]] = await db.query('SELECT status, locked_at, attempts FROM social_posts WHERE id = ?', [PID]);
  ok(after.status === 'needs_manual', 'and it waits to be told it went out', after.status);
  ok(after.locked_at === null, 'with the claim released, so a crashed run cannot strand it');

  const [[logged]] = await db.query(
    "SELECT COUNT(*) n FROM social_publish_log WHERE post_id = ? AND level = 'info'", [PID]);
  ok(Number(logged.n) >= 1, 'and the handover is on the record');
}

// ---- the same run twice must not double post ----------------------------------------
{
  await db.query("UPDATE social_posts SET status = 'scheduled', locked_at = NULL, scheduled_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?", [PID]);
  const [a, b] = await Promise.all([
    fetch(API + '/cron/social-publish', { method: 'POST', headers: { 'X-Cron-Key': CRON_KEY } }).then((r) => r.json()),
    fetch(API + '/cron/social-publish', { method: 'POST', headers: { 'X-Cron-Key': CRON_KEY } }).then((r) => r.json()),
  ]);
  const total = (a.claimed ?? 0) + (b.claimed ?? 0);
  ok(total === 1, 'two runs at once claim it exactly once between them', `${a.claimed} + ${b.claimed}`);
}

// ---- marking it posted by hand, per network -----------------------------------------
{
  const one = await post(`/social/posts/${PID}/mark-manual-done`, {
    network: 'instagram', permalink: 'https://www.instagram.com/p/e2e/',
  });
  ok(one.status === 200, 'one network can be marked as posted', String(one.status));
  const oneBody = await one.json();
  ok(oneBody.complete === false, 'and the post is NOT finished while the other two are still waiting');

  const [[ig]] = await db.query("SELECT status, permalink FROM social_post_targets WHERE post_id = ? AND network = 'instagram'", [PID]);
  ok(ig.status === 'manual_done' && ig.permalink.includes('instagram.com'), 'with the link kept against that network', ig.status);

  const rest = await post(`/social/posts/${PID}/mark-manual-done`, {});
  const restBody = await rest.json();
  ok(restBody.complete === true, 'once the rest are marked, the post is done');
  const [[p]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [PID]);
  ok(p.status === 'published', 'and it reads as published', p.status);
}

// ---- importing a planned calendar ----------------------------------------------------
{
  const res = await post('/social/import/calendar', {
    businessId: BID, timezone: 'Africa/Johannesburg', defaultTime: '09:00',
    networks: ['instagram', 'facebook'], deliveryMode: 'manual',
    posts: [
      { date: '2026-10-05', title: 'E2E-SOC Spring menu', caption: 'Iced season is back.', mediaAsk: 'PHOTO: an iced coffee made this week.' },
      { date: '2026-10-07', time: '14:30', title: 'E2E-SOC Franchise Friday', caption: 'Two models, one counter.' },
    ],
  });
  ok(res.status === 201, 'a planned calendar imports', String(res.status));
  const body = await res.json();
  ok(body.created === 2, 'creating one post per row', String(body.created));

  const [rows] = await db.query(
    "SELECT title, status, DATE_FORMAT(scheduled_at, '%Y-%m-%d %H:%i') t FROM social_posts WHERE account_id = 1 AND title LIKE 'E2E-SOC Spring%' OR title LIKE 'E2E-SOC Franchise%' ORDER BY scheduled_at");
  const spring = rows.find((r) => r.title.includes('Spring'));
  ok(spring?.status === 'needs_media',
    'a post that asks the client for a photo lands as needs_media, not as a finished draft', spring?.status);
  // 09:00 in Johannesburg is 07:00 UTC. Storing the wall clock would be an hour out.
  ok(spring?.t === '2026-10-05 07:00',
    'and the local time is converted to UTC using the real zone, not assumed', spring?.t);
  const friday = rows.find((r) => r.title.includes('Franchise'));
  ok(friday?.t === '2026-10-07 12:30', 'a per-post time is honoured too', friday?.t);
}

// ---- deleting: a draft goes, anything scheduled is kept as cancelled -----------------
{
  const mk = await post('/social/posts', { businessId: BID, title: 'E2E-SOC Throwaway', networks: ['facebook'] });
  const tid = (await mk.json()).id;
  const del = await fetch(API + `/social/posts/${tid}`, { method: 'DELETE', headers: { cookie } });
  ok((await del.json()).deleted === true, 'a draft is deleted outright');

  const del2 = await fetch(API + `/social/posts/${PID}`, { method: 'DELETE', headers: { cookie } });
  const b2 = await del2.json();
  ok(b2.deleted === false, 'but a post that already went out is cancelled, not erased');
  const [[still]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [PID]);
  ok(still?.status === 'cancelled', 'so the calendar keeps the record that it existed', still?.status);
}

await clean();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
