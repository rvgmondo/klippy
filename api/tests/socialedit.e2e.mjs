/**
 * Editing a post that is already scheduled, and which Page a post goes to.
 *
 * What this proves, each written to FAIL against the old code:
 *
 *   1. AN EDIT THAT CHANGES NOTHING OUT THERE KEEPS THE POST SCHEDULED. Any autosave used
 *      to take a scheduled post off the schedule, including one that changed nothing, a
 *      new title, or a new date (which it did not even save). The publisher only takes
 *      scheduled posts, so the post silently never went out.
 *   2. AN EDIT THAT DOES CHANGE WHAT GOES OUT SAYS SO, and lands in draft, not in an
 *      'approved' nobody gave, which later produced a false "changed after it was signed
 *      off". Whether such an edit should instead stay scheduled is an open decision; this
 *      pins the honest version of what happens today.
 *   3. A POST KEEPS THE PAGE IT WAS SET TO. Every save used to re-pick the account from an
 *      unordered list, last one wins, so connecting a second Page moved existing posts to
 *      it on their next autosave. With two connected, a new post is not guessed onto one.
 *   4. A NOTIFICATION ABOUT A POST LINKS TO THAT POST.
 *
 * Run with a test server on 8095 (or set KLIPPY_API) with CRON_SECRET=e2e-cron-secret.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = process.env.KLIPPY_API ?? 'http://localhost:8095/api/v1';
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

const TAG = 'E2E-SE';
const clean = async () => {
  await db.query('DELETE FROM social_posts WHERE account_id = 1 AND title LIKE ?', [`${TAG}%`]);
  await db.query("DELETE FROM social_accounts WHERE account_id = 1 AND external_id LIKE 'e2e-se-%'");
  await db.query("DELETE FROM storage_nodes WHERE account_id = 1 AND name LIKE 'e2e-se%'");
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
const patchJ = async (p, b) => {
  const r = await fetch(API + p, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const BID = biz.id;
const [[userRow]] = await db.query("SELECT id FROM users WHERE email = 'ruben@x.com'");

const statusOf = async (id) => (await db.query('SELECT status FROM social_posts WHERE id = ?', [id]))[0][0].status;
const whenOf = async (id) => (await db.query(
  "SELECT DATE_FORMAT(scheduled_at, '%Y-%m-%dT%H:%i') w FROM social_posts WHERE id = ?", [id]))[0][0].w;
const logsOf = async (id, like) => Number((await db.query(
  'SELECT COUNT(*) n FROM social_publish_log WHERE post_id = ? AND message LIKE ?', [id, like]))[0][0].n);

const inAWeek = new Date(Date.now() + 7 * 86400_000);
inAWeek.setUTCSeconds(0, 0);

/** What the composer's autosave sends, from what is stored. */
const autosaveBody = (p) => ({
  title: p.title, caption: p.caption, firstComment: null, postType: 'post',
  deliveryMode: 'manual', mediaAsk: null, networks: ['linkedin'],
});

const scheduledPost = async (label) => {
  const body = {
    businessId: BID, title: `${TAG} ${label}`, caption: 'Iced coffee is back from Monday.',
    deliveryMode: 'manual', networks: ['linkedin'], scheduledAt: inAWeek.toISOString(),
  };
  const id = (await (await post('/social/posts', body)).json()).id;
  const s = await post(`/social/posts/${id}/schedule`, {});
  ok(s.status === 200 && (await statusOf(id)) === 'scheduled', `"${label}" is scheduled`, String(s.status));
  return { id, ...body };
};

// ---- 1. edits that change nothing out there -----------------------------------------
{
  const p = await scheduledPost('No-op autosave');
  const r = await patchJ(`/social/posts/${p.id}`, autosaveBody(p));
  ok(r.status === 200 && (await statusOf(p.id)) === 'scheduled',
    'an autosave that changes nothing leaves the post scheduled', await statusOf(p.id));
  ok(r.body?.unscheduled === false, 'and says nothing was unscheduled', JSON.stringify(r.body));
}
{
  const p = await scheduledPost('Title only');
  await patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), title: `${TAG} Title only, renamed` });
  ok((await statusOf(p.id)) === 'scheduled', 'renaming the internal title leaves it scheduled', await statusOf(p.id));
}
{
  const p = await scheduledPost('Moved to Thursday');
  const later = new Date(inAWeek.getTime() + 2 * 86400_000);
  await patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), scheduledAt: later.toISOString() });
  ok((await statusOf(p.id)) === 'scheduled', 'moving the date leaves it scheduled', await statusOf(p.id));
  ok((await whenOf(p.id)) === later.toISOString().slice(0, 16),
    'and the new time is the one saved, so it goes out when the drawer says', `${await whenOf(p.id)} vs ${later.toISOString().slice(0, 16)}`);
}
{
  // Changing the date before the time passes through moments already gone.
  const p = await scheduledPost('Passed through the past');
  const before = await whenOf(p.id);
  const past = new Date(Date.now() - 4 * 3600_000);
  const r = await patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), scheduledAt: past.toISOString() });
  ok(r.status === 400 && (await statusOf(p.id)) === 'scheduled' && (await whenOf(p.id)) === before,
    'a scheduled post cannot be given a time that has passed, which the publisher would take as "now"',
    `${r.status} ${await statusOf(p.id)} ${await whenOf(p.id)}`);
}
{
  // The autosave and the Save button overlapping, both changing the words.
  const p = await scheduledPost('Two saves at once');
  const [a, b] = await Promise.all([
    patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), caption: 'First version.' }),
    patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), caption: 'Second version.' }),
  ]);
  const [[row]] = await db.query('SELECT status, caption FROM social_posts WHERE id = ?', [p.id]);
  ok(a.status === 200 && b.status === 200,
    'two saves landing together are both taken, not one refused as "going out now"', `${a.status} ${b.status}`);
  ok(row.status === 'draft' && ['First version.', 'Second version.'].includes(row.caption),
    'and the post ends in draft with one of the two captions', JSON.stringify(row));
}
{
  const p = await scheduledPost('Date cleared');
  const r = await patchJ(`/social/posts/${p.id}`, { scheduledAt: null });
  ok((await statusOf(p.id)) === 'draft' && r.body?.unscheduled === true,
    'clearing the time takes it off the schedule and says so, instead of leaving a scheduled post with no time to go out',
    `${await statusOf(p.id)} ${JSON.stringify(r.body)}`);
}

// ---- 2. edits that change what goes out ----------------------------------------------

{
  const p = await scheduledPost('Typo fixed');

  const r = await patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), caption: 'Iced coffee is back from Monday!' });
  ok(r.body?.unscheduled === true && r.body?.approvalWithdrawn === false,
    'changing the words of a scheduled post says it came off the schedule', JSON.stringify(r.body));
  ok((await statusOf(p.id)) === 'draft',
    "and lands in draft, not in an 'approved' no client gave", await statusOf(p.id));
  ok((await logsOf(p.id, '%came off the schedule%')) === 1, 'with a line in the post history saying so');

  await patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), caption: 'Iced coffee is back from Monday.' });
  ok((await logsOf(p.id, '%signed off%')) === 0,
    'a later edit does not claim the post "changed after it was signed off" when nobody signed it off');
}
{
  // A post a client really approved, then scheduled, then edited.
  const p = await scheduledPost('Approved then edited');
  await db.query(
    "UPDATE social_posts SET approved_at = UTC_TIMESTAMP(), approved_by_name = 'Thandi', approval_token = ? WHERE id = ?",
    ['e'.repeat(64), p.id]);
  const r = await patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), caption: 'A different promise.' });
  const [[row]] = await db.query('SELECT status, approved_at, approval_token FROM social_posts WHERE id = ?', [p.id]);
  ok(r.body?.approvalWithdrawn === true && r.body?.unscheduled === true,
    'a signed-off scheduled post that is edited reports both: approval withdrawn and off the schedule', JSON.stringify(r.body));
  ok(row.status === 'draft' && row.approved_at === null && row.approval_token === null,
    'and ends in draft with the sign-off and the link gone', JSON.stringify(row));
}
{
  // Rows the old bug left behind: 'approved' with nobody's approval.
  const p = await scheduledPost('Old false approval');
  await db.query("UPDATE social_posts SET status = 'approved' WHERE id = ?", [p.id]);
  const r = await patchJ(`/social/posts/${p.id}`, { ...autosaveBody(p), caption: 'Fixed a typo.' });
  ok(r.body?.approvalWithdrawn === false && (await logsOf(p.id, '%signed off%')) === 0,
    "a post the old bug marked 'approved' is not treated as signed off when edited", JSON.stringify(r.body));
  ok((await statusOf(p.id)) === 'draft', 'and it stops calling itself approved', await statusOf(p.id));
}
{
  const p = await scheduledPost('Photo swapped');
  const PIXEL = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
  const form = new FormData();
  form.append('file', new Blob([PIXEL], { type: 'image/jpeg' }), 'e2e-se-photo.jpg');
  const up = await fetch(API + `/social/posts/${p.id}/media?width=1080&height=1080`, { method: 'POST', headers: { cookie }, body: form });
  const body = await up.json();
  ok(up.status === 201 && body.unscheduled === true && (await statusOf(p.id)) === 'draft',
    'adding a photo to a scheduled post takes it off the schedule too, and says so, rather than staying scheduled unchecked',
    `${up.status} ${await statusOf(p.id)} ${JSON.stringify({ unscheduled: body.unscheduled })}`);
}
{
  const p = await scheduledPost('Already out');
  await db.query("UPDATE social_posts SET status = 'published', approved_at = UTC_TIMESTAMP() WHERE id = ?", [p.id]);
  const PIXEL = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
  const form = new FormData();
  form.append('file', new Blob([PIXEL], { type: 'image/jpeg' }), 'e2e-se-late.jpg');
  const up = await fetch(API + `/social/posts/${p.id}/media?width=1080&height=1080`, { method: 'POST', headers: { cookie }, body: form });
  ok(up.status === 409 && (await statusOf(p.id)) === 'published',
    'a photo cannot be added to a post that already went out, which used to knock it back to draft',
    `${up.status} ${await statusOf(p.id)}`);
}
{
  const p = await scheduledPost('Unschedule');
  const u = await post(`/social/posts/${p.id}/unschedule`);
  ok(u.status === 200 && (await statusOf(p.id)) === 'draft',
    "unscheduling a post nobody approved puts it back in draft, not 'approved'", await statusOf(p.id));
  await db.query("UPDATE social_posts SET status = 'published' WHERE id = ?", [p.id]);
  const again = await post(`/social/posts/${p.id}/unschedule`);
  ok(again.status === 409 && (await statusOf(p.id)) === 'published',
    'and a published post cannot be rewritten by unscheduling it', `${again.status} ${await statusOf(p.id)}`);
}

// ---- 3. which Page a post goes to ----------------------------------------------------
const [[fbBefore]] = await db.query(
  "SELECT COUNT(*) n FROM social_accounts WHERE business_id = ? AND network = 'facebook'", [BID]);
if (Number(fbBefore.n) > 0) {
  console.log('SKIP  this business already has Facebook accounts, so the Page checks would not be clean');
} else {
  const connect = async (ext, name) => {
    const [r] = await db.query(
      `INSERT INTO social_accounts (account_id, business_id, network, external_id, display_name, status, connected_by)
       VALUES (1, ?, 'facebook', ?, ?, 'connected', ?)`, [BID, ext, name, userRow.id]);
    return r.insertId;
  };
  const boundTo = async (postId) => (await db.query(
    "SELECT social_account_id a FROM social_post_targets WHERE post_id = ? AND network = 'facebook'", [postId]))[0][0]?.a ?? null;
  const fbBody = (title) => ({
    title, caption: 'Open late on Friday.', firstComment: null, postType: 'post',
    deliveryMode: 'auto', mediaAsk: null, networks: ['facebook'],
  });

  const early = (await (await post('/social/posts', {
    businessId: BID, ...fbBody(`${TAG} Written before connecting`), scheduledAt: inAWeek.toISOString(),
  })).json()).id;
  ok((await boundTo(early)) === null, 'a post written with nothing connected goes nowhere yet');

  const pageA = await connect('e2e-se-a', 'E2E Page A');
  await post(`/social/posts/${early}/schedule`, {});
  await db.query("UPDATE social_posts SET scheduled_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE), locked_at = NULL WHERE id = ?", [early]);
  await fetch(API + '/cron/social-publish', { method: 'POST', headers: { 'X-Cron-Key': CRON_KEY } });
  ok((await boundTo(early)) === pageA,
    'at publish time, a post never saved since its only Page was connected goes to that Page', `bound to ${await boundTo(early)}`);
  const first = (await (await post('/social/posts', { businessId: BID, ...fbBody(`${TAG} Page A post`) })).json()).id;
  ok((await boundTo(first)) === pageA, 'with one Page connected, a new post goes to it');

  const pageB = await connect('e2e-se-b', 'E2E Page B');
  ok((await boundTo(first)) === pageA, 'connecting a second Page changes nothing by itself');
  await patchJ(`/social/posts/${first}`, fbBody(`${TAG} Page A post`));
  ok((await boundTo(first)) === pageA,
    'and an idle autosave does NOT move the post to the newly connected Page', `bound to ${await boundTo(first)}, A=${pageA} B=${pageB}`);

  const second = (await (await post('/social/posts', { businessId: BID, ...fbBody(`${TAG} Which Page`) })).json()).id;
  ok((await boundTo(second)) === null,
    'with two Pages connected, a new post is not guessed onto one of them', `bound to ${await boundTo(second)}`);

  const copy = (await (await post(`/social/posts/${first}/duplicate`)).json()).id;
  ok((await boundTo(copy)) === pageA, 'a duplicate goes to the same Page as the original', `bound to ${await boundTo(copy)}`);

  // The audit lists what may have been moved before this was fixed.
  const audit = await (await fetch(API + '/admin/directory-audit', { headers: { cookie } })).json();
  const h = audit.checks?.find((c) => c.key === 'h')?.rows ?? [];
  ok(h.some((r) => r.postId === first && r.goesTo === 'E2E Page A') && h.some((r) => r.postId === second && r.goesTo === null),
    'the read-only audit lists posts on a business with two Pages on one network, and where each goes', `${h.length} rows`);

  // The publisher says why an unbound post came to a person.
  const sch = await post(`/social/posts/${second}/schedule`, { scheduledAt: inAWeek.toISOString() });
  await db.query("UPDATE social_posts SET scheduled_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE), locked_at = NULL WHERE id = ?", [second]);
  const run = await (await fetch(API + '/cron/social-publish', { method: 'POST', headers: { 'X-Cron-Key': CRON_KEY } })).json();
  const [said] = await db.query('SELECT message FROM social_publish_log WHERE post_id = ? ORDER BY id', [second]);
  ok((await logsOf(second, '%More than one Facebook account%')) === 1,
    'at publish time, the reason is that several Pages are connected, not "add your Meta app details"',
    `schedule ${sch.status}, run ${run.message}, log: ${said.map((r) => r.message).join(' | ').slice(0, 300)}`);

  // Page A is disconnected in the app. Its posts must not slide onto Page B.
  const off = await fetch(API + `/social/accounts/${pageA}`, { method: 'DELETE', headers: { cookie } });
  ok(off.status === 200, 'Page A is disconnected', String(off.status));
  const [[aRow]] = await db.query('SELECT status, access_token_enc FROM social_accounts WHERE id = ?', [pageA]);
  ok(aRow?.status === 'revoked' && aRow.access_token_enc === null,
    'disconnecting wipes its token and keeps the row, marked revoked', JSON.stringify(aRow));
  await patchJ(`/social/posts/${first}`, fbBody(`${TAG} Page A post`));
  ok((await boundTo(first)) === pageA,
    'and a post that was going to it stays pointed at it, instead of moving to the Page still connected',
    `bound to ${await boundTo(first)}, A=${pageA} B=${pageB}`);
  const listed = (await (await fetch(API + '/social/accounts', { headers: { cookie } })).json()).accounts
    .find((a) => a.id === pageA);
  ok(listed?.disconnected === true, 'the account list says it was disconnected, so the screen can leave it out');
}

// ---- 4. a notification about a post links to it --------------------------------------
{
  const id = (await (await post('/social/posts', {
    businessId: BID, title: `${TAG} Sent back`, caption: 'Words.', deliveryMode: 'manual', networks: ['linkedin'],
  })).json()).id;
  const link = (await (await post(`/social/posts/${id}/request-approval`)).json()).approvalUrl;
  const tok = new URL(link, 'http://x').searchParams.get('approve');
  await fetch(API + `/approve/${tok}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'changes', name: 'Thandi', comment: 'Say Tuesday, not Monday.' }),
  });
  const [[n]] = await db.query('SELECT url FROM notifications WHERE account_id = 1 ORDER BY id DESC LIMIT 1');
  ok(n?.url === `/?v=social&post=${id}`, 'the "asked for changes" notification opens that post', n?.url);
}


await clean();
await db.end();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures ? 1 : 0);
