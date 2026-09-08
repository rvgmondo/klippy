/**
 * Klippy Social, phase 5: getting a client to say yes.
 *
 * What this proves, in the order it matters:
 *
 *   1. THE PAGE OPENS WITH NO SESSION. Every request below that stands in for the
 *      client is made with no cookie at all, because the client has no login and
 *      never will. A 401 here is a post that never gets approved.
 *   2. THE TOKEN IS THE ONLY SCOPE, AND IT IS TIGHT. It reaches one post. It does not
 *      carry the internal title, the media ask, the log, or any sign that another
 *      post exists. A wrong token is a 404 and not a hint.
 *   3. AN ANSWER CAN ONLY BE GIVEN ONCE. A second tap on a link sitting in a mailbox
 *      must not unpick a sign-off or contradict a change request.
 *   4. AN APPROVAL DIES WITH THE WORDS IT WAS FOR. Edit the caption after sign-off and
 *      the approval is gone, because otherwise a post nobody agreed to goes out with
 *      a client's name on the approval. This is the one that would be silent.
 *   5. WITHDRAWING REALLY WITHDRAWS. The link stops working on the next request, not
 *      at some expiry.
 *
 * Run with a test server on 8095 started with CRON_SECRET and AUTH_RATE_LIMIT_MAX set.
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
  await db.query("DELETE FROM social_posts WHERE account_id = 1 AND title LIKE 'E2E-APR%'");
  await db.query("DELETE FROM storage_nodes WHERE account_id = 1 AND name LIKE 'e2e-apr-%'");
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
// Cookie only, no content type. Fastify refuses a bodyless request that claims to be
// JSON ("Body cannot be empty when content-type is set to 'application/json'"), which
// turns a delete into a silent 400 and a test into a green lie.
const del = (p) => fetch(API + p, { method: 'DELETE', headers: { cookie } });

/**
 * The client's browser. NO COOKIE, deliberately, on every single call: this is the
 * whole point of the route and the easiest thing to accidentally undo.
 */
const anon = (p, init = {}) => fetch(API + p, { ...init, headers: { ...(init.headers ?? {}) } });
const anonJson = async (p, init) => {
  const r = await anon(p, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const BID = biz.id;

/** A real one-pixel JPEG, so the media routes are exercised rather than mocked. */
const PIXEL = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

const postMedia = async (postId, name) => {
  const form = new FormData();
  form.append('file', new Blob([PIXEL], { type: 'image/jpeg' }), name);
  return fetch(API + `/social/posts/${postId}/media?width=1&height=1`, {
    method: 'POST', headers: { cookie }, body: form,
  });
};

/** Send for sign-off and approve as the client. Returns the token. */
const approveIt = async (postId, name) => {
  const link = (await (await post(`/social/posts/${postId}/request-approval`)).json()).approvalUrl;
  const tok = new URL(link, 'http://x').searchParams.get('approve');
  await anonJson(`/approve/${tok}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', name }),
  });
  return tok;
};

const makePost = async (title, caption) => {
  const r = await post('/social/posts', {
    businessId: BID, title, caption,
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    networks: ['facebook', 'linkedin'],
  });
  return (await r.json()).id;
};

// ---- a link is made, and it is not guessable ---------------------------------------
let PID; let TOKEN; let LINK;
{
  PID = await makePost('E2E-APR the one being approved', 'Two models, one counter. Open until five.');
  const r = await post(`/social/posts/${PID}/request-approval`);
  const body = await r.json();
  LINK = body.approvalUrl ?? '';
  TOKEN = new URL(LINK, 'http://x').searchParams.get('approve') ?? '';

  ok(r.status === 200, 'a post can be sent for approval', String(r.status));
  ok(/^[a-f0-9]{64}$/.test(TOKEN), 'and the link carries 32 random bytes, not an id', TOKEN.slice(0, 12) + '...');
  ok(LINK.includes('/?approve='),
    'the link is a query string, because the static site has no rewrite and a path would 404 before any JS runs',
    LINK.replace(TOKEN, 'TOKEN'));

  const [[row]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [PID]);
  ok(row.status === 'awaiting_approval', 'and the post now says it is waiting', row.status);
}

// ---- the client opens it with no session, and sees only their own post -------------
{
  const { status, body } = await anonJson(`/approve/${TOKEN}`);
  ok(status === 200, 'the page loads with NO cookie at all, which is the entire point', String(status));
  ok(body.outcome === 'awaiting', 'it says it is waiting on them', body.outcome);
  ok(body.post.caption.startsWith('Two models'), 'the caption is there');
  ok(body.post.networks.length === 2, 'once per network, so an override is never shown as the other one',
    String(body.post.networks.length));

  // What must NOT be in it. The internal title especially: it is a working label
  // ("E2E-APR the one being approved") that no client should ever read.
  const flat = JSON.stringify(body);
  ok(!flat.includes('E2E-APR'), 'the internal title is not in the response');
  ok(!flat.includes('mediaAsk') && !flat.includes('approvalToken'),
    'nor the media ask, nor the token echoed back');
  ok(!('log' in body.post) && !('id' in body.post),
    'nor the publish log, nor the post id, so there is nothing to walk to');
  ok(!!body.brand?.name, 'and it wears the business name, not Klippy', body.brand?.name);
}

// ---- a wrong token is a flat 404, not a hint ---------------------------------------
{
  const bad = await anonJson('/approve/' + 'f'.repeat(64));
  ok(bad.status === 404, 'a token that never existed is a 404', String(bad.status));
  const short = await anonJson('/approve/abc');
  ok(short.status === 404, 'and so is a nonsense one, refused before the database is touched');
  ok(bad.body?.error === short.body?.error, 'with the same words both times, so guesses learn nothing');
}

// ---- approving needs a name --------------------------------------------------------
{
  const nameless = await anonJson(`/approve/${TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });
  ok(nameless.status === 400, 'approving without a name is refused: an approval nobody signed is not one',
    String(nameless.status));

  const silent = await anonJson(`/approve/${TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'changes', name: 'Thandi' }),
  });
  ok(silent.status === 400, 'and asking for changes without saying what is refused too', String(silent.status));
}

// ---- the approval itself -----------------------------------------------------------
{
  const r = await anonJson(`/approve/${TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', name: 'Thandi at Early Bird' }),
  });
  ok(r.status === 200 && r.body.outcome === 'approved', 'the client approves it', String(r.status));

  const [[row]] = await db.query(
    'SELECT status, approved_by_name, approved_at FROM social_posts WHERE id = ?', [PID]);
  ok(row.status === 'approved', 'the post moves to approved', row.status);
  ok(row.approved_by_name === 'Thandi at Early Bird', 'with the name that signed it', row.approved_by_name);
  ok(!!row.approved_at, 'and when');

  const [[log]] = await db.query(
    'SELECT message FROM social_publish_log WHERE post_id = ? ORDER BY id DESC LIMIT 1', [PID]);
  ok(/Thandi/.test(log?.message ?? ''), 'and the agency has it in the post history', log?.message);
}

// ---- the same link cannot be used twice --------------------------------------------
{
  const again = await anonJson(`/approve/${TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'changes', name: 'Someone else', comment: 'Actually no.' }),
  });
  ok(again.status === 409, 'a second answer on the same link is refused, not applied', String(again.status));

  const [[row]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [PID]);
  ok(row.status === 'approved', 'so the sign-off stands', row.status);

  const view = await anonJson(`/approve/${TOKEN}`);
  ok(view.body.outcome === 'approved' && view.body.decision?.name === 'Thandi at Early Bird',
    'and the link still opens, showing them what they already decided');
}

/**
 * ---- the one that would otherwise be silent ---------------------------------------
 *
 * An approval is for the words the client read. Change them and it has to die, or the
 * post that goes out is one nobody agreed to, carrying their name as the approver.
 */
{
  await patch(`/social/posts/${PID}`, { caption: 'Half price all week, actually.' });
  const [[row]] = await db.query(
    'SELECT status, approved_at, approved_by_name FROM social_posts WHERE id = ?', [PID]);
  ok(row.status === 'draft', 'editing the caption of an approved post sends it back to draft', row.status);
  ok(!row.approved_at && !row.approved_by_name,
    'and the sign-off is gone, so nobody is recorded as approving words they never saw');

  // The internal title is not published and is nobody's business but the agency's, so
  // renaming it must NOT cost a real approval.
  // A fresh link, because the edit above withdrew the old one along with the approval.
  const relink = (await (await post(`/social/posts/${PID}/request-approval`)).json()).approvalUrl;
  const fresh = new URL(relink, 'http://x').searchParams.get('approve');
  ok(fresh !== TOKEN, 'an edited post gets a NEW link, since the old one was withdrawn with the approval');
  TOKEN = fresh;
  await anonJson(`/approve/${TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', name: 'Thandi' }),
  });
  await patch(`/social/posts/${PID}`, { title: 'E2E-APR renamed internally' });
  const [[after]] = await db.query('SELECT status, approved_by_name FROM social_posts WHERE id = ?', [PID]);
  ok(after.status === 'approved' && after.approved_by_name === 'Thandi',
    'while renaming the internal label leaves the approval alone', after.status);
}

// ---- asking for changes ------------------------------------------------------------
{
  const P2 = await makePost('E2E-APR the one sent back', 'Come in for a coffee.');
  const link = (await (await post(`/social/posts/${P2}/request-approval`)).json()).approvalUrl;
  const t2 = new URL(link, 'http://x').searchParams.get('approve');

  const r = await anonJson(`/approve/${t2}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'changes', name: 'Thandi', comment: 'Use the photo with the blue cup.' }),
  });
  ok(r.status === 200 && r.body.outcome === 'changes', 'the client can send it back instead', String(r.status));

  const [[row]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [P2]);
  ok(row.status === 'draft', 'which puts it back in the agency court', row.status);

  const [[log]] = await db.query(
    'SELECT message, level FROM social_publish_log WHERE post_id = ? ORDER BY id DESC LIMIT 1', [P2]);
  ok(/blue cup/.test(log?.message ?? ''), 'with their words kept exactly as written', log?.message);
  ok(log?.level === 'warn', 'and marked as something needing attention, not an aside', log?.level);

  const view = await anonJson(`/approve/${t2}`);
  ok(view.body.outcome === 'changes', 'and the client sees that their note landed', view.body.outcome);

  // The same link is reused when it goes round again, so the client can go back to the
  // message they already have rather than hunting for a newer one.
  const relink = (await (await post(`/social/posts/${P2}/request-approval`)).json()).approvalUrl;
  ok(relink === link, 'sending it round again reuses the same link');
}

// ---- withdrawing ---------------------------------------------------------------------
{
  const P3 = await makePost('E2E-APR the one withdrawn', 'Something we changed our mind about.');
  const link = (await (await post(`/social/posts/${P3}/request-approval`)).json()).approvalUrl;
  const t3 = new URL(link, 'http://x').searchParams.get('approve');
  ok((await anonJson(`/approve/${t3}`)).status === 200, 'a fresh link opens');

  await post(`/social/posts/${P3}/revoke-approval`);
  const after = await anonJson(`/approve/${t3}`);
  ok(after.status === 404, 'and stops working the moment it is withdrawn, including in a message already sent',
    String(after.status));

  const decide = await anonJson(`/approve/${t3}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', name: 'Too late' }),
  });
  ok(decide.status === 404, 'a withdrawn link cannot approve anything either', String(decide.status));

  const [[row]] = await db.query('SELECT status, approval_token FROM social_posts WHERE id = ?', [P3]);
  ok(row.approval_token === null, 'because the token is gone from the row, not merely marked');
  ok(row.status === 'draft', 'and the post is back to a draft', row.status);
}

/**
 * ---- an approval covers the PICTURES, not only the words --------------------------
 *
 * Found by review, and it was the biggest hole in the feature: the clearing rule
 * listed caption, firstComment, postType and networks, and media is what a client
 * actually looks at. Every one of these three routes left the sign-off standing.
 */
{
  const P = await makePost('E2E-APR the one whose photo was swapped', 'Two models, one counter.');
  await approveIt(P, 'Thandi');

  // A photo arriving is a different post from the one that was approved.
  const up = await postMedia(P, 'e2e-apr-swap.jpg');
  ok(up.status === 201, 'a photo can be added to an approved post', String(up.status));
  const [[afterAdd]] = await db.query(
    'SELECT status, approved_by_name, approval_token FROM social_posts WHERE id = ?', [P]);
  ok(afterAdd.status === 'draft' && !afterAdd.approved_by_name,
    'adding a photo to an approved post throws the sign-off away', afterAdd.status);
  ok(afterAdd.approval_token === null,
    'and takes the link with it, so the client is not left holding a stale one');

  // And deleting one.
  const P2 = await makePost('E2E-APR the one whose photo was deleted', 'Words.');
  const m2 = await (await postMedia(P2, 'e2e-apr-del.jpg')).json();
  await approveIt(P2, 'Thandi');
  const gone = await del(`/social/posts/${P2}/media/${m2.id}`);
  ok(gone.status === 200, 'the photo can be deleted', String(gone.status));
  const [[afterDel]] = await db.query('SELECT status, approved_by_name FROM social_posts WHERE id = ?', [P2]);
  ok(afterDel.status === 'draft' && !afterDel.approved_by_name,
    'deleting the approved photo throws the sign-off away too', afterDel.status);

  // And reordering, which on Instagram changes the crop of every image in a carousel.
  const P3 = await makePost('E2E-APR the carousel that was reordered', 'Words.');
  const a = await (await postMedia(P3, 'e2e-apr-a.jpg')).json();
  const b = await (await postMedia(P3, 'e2e-apr-b.jpg')).json();
  await approveIt(P3, 'Thandi');
  const re = await post(`/social/posts/${P3}/reorder-media`, { order: [b.id, a.id] });
  ok(re.status === 200, 'the carousel can be reordered', String(re.status));
  const [[afterRe]] = await db.query('SELECT status, approved_by_name FROM social_posts WHERE id = ?', [P3]);
  ok(afterRe.status === 'draft' && !afterRe.approved_by_name,
    'and reordering a carousel does as well, since the lead image sets the crop', afterRe.status);
}

/**
 * ---- a post out for sign-off cannot be scheduled behind the client's back ----------
 *
 * The worst of the findings: nothing stopped awaiting_approval going straight to
 * scheduled, the publisher claims on status alone, and the client then opens their
 * link and is told it was approved.
 */
{
  const P = await makePost('E2E-APR the one scheduled behind their back', 'Going out whatever you say.');
  const link = (await (await post(`/social/posts/${P}/request-approval`)).json()).approvalUrl;
  const tok = new URL(link, 'http://x').searchParams.get('approve');

  const sched = await post(`/social/posts/${P}/schedule`, {
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  });
  ok(sched.status === 409, 'scheduling a post that is still with the client is refused', String(sched.status));

  const [[row]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [P]);
  ok(row.status === 'awaiting_approval', 'so it stays with them', row.status);

  const view = await anonJson(`/approve/${tok}`);
  ok(view.body.outcome === 'awaiting',
    'and their page still asks for an answer rather than claiming they gave one', view.body.outcome);

  // Withdrawing the link is the deliberate way through, and then it schedules.
  await post(`/social/posts/${P}/revoke-approval`);
  const after = await post(`/social/posts/${P}/schedule`, {
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  });
  ok(after.status === 200, 'withdrawing the link first is the way through', String(after.status));
}

/**
 * ---- a staff edit must not tell the client they asked for changes ------------------
 *
 * draft plus a live token is how the page recognises a post the CLIENT sent back. A
 * staff edit used to leave one behind, so the client's own page told them their notes
 * had landed, for notes they never wrote, and refused their answer.
 */
{
  const P = await makePost('E2E-APR the one edited under them', 'First words.');
  const link = (await (await post(`/social/posts/${P}/request-approval`)).json()).approvalUrl;
  const tok = new URL(link, 'http://x').searchParams.get('approve');
  ok((await anonJson(`/approve/${tok}`)).status === 200, 'the client can open it');

  await patch(`/social/posts/${P}`, { caption: 'Second words, changed under them.' });

  const view = await anonJson(`/approve/${tok}`);
  ok(view.status === 404,
    'once staff edit it, the old link is dead rather than lying about what happened', String(view.status));

  const decide = await anonJson(`/approve/${tok}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', name: 'Thandi' }),
  });
  ok(decide.status === 404, 'and cannot approve words that were replaced');

  const [[log]] = await db.query(
    'SELECT message FROM social_publish_log WHERE post_id = ? ORDER BY id DESC LIMIT 1', [P]);
  ok(/withdrawn/i.test(log?.message ?? ''), 'with the reason recorded for whoever reopens it', log?.message);
}

// ---- a cancelled post does not read as approved and still going out ----------------
{
  const P = await makePost('E2E-APR the one cancelled after sign-off', 'Never mind.');
  const tok = await approveIt(P, 'Thandi');
  await del(`/social/posts/${P}`);

  const [[row]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [P]);
  ok(row.status === 'cancelled', 'the post is cancelled', row.status);

  const view = await anonJson(`/approve/${tok}`);
  ok(view.body.outcome === 'closed',
    'and the client is told there is nothing to do, not that it is approved', view.body.outcome);
  ok(view.body.post.whenLabel === null,
    'with no date promised for a post that will never go out', String(view.body.post.whenLabel));
}

/**
 * ---- an idle autosave does not throw away a real approval --------------------------
 *
 * The composer PATCHes every 700ms and sends '' for a first comment that was never
 * filled in, against a column holding NULL. Treating that as a change would withdraw
 * a sign-off nobody touched.
 */
{
  const P = await makePost('E2E-APR the one autosaved', 'Unchanged words.');
  await approveIt(P, 'Thandi');
  await patch(`/social/posts/${P}`, {
    caption: 'Unchanged words.', firstComment: '', postType: 'post', networks: ['linkedin', 'facebook'],
  });
  const [[row]] = await db.query('SELECT status, approved_by_name FROM social_posts WHERE id = ?', [P]);
  ok(row.status === 'approved' && row.approved_by_name === 'Thandi',
    'an autosave that changes nothing leaves the approval alone', `${row.status} / ${row.approved_by_name}`);

  // The empty string is only "no change" against a null. Real words still count.
  await patch(`/social/posts/${P}`, { firstComment: '#coffee' });
  const [[after]] = await db.query('SELECT status FROM social_posts WHERE id = ?', [P]);
  ok(after.status === 'draft', 'while a first comment that really arrives does withdraw it', after.status);
}

// ---- the staff side sees the link, and only the staff side -------------------------
{
  const detail = await getj(`/social/posts/${PID}`);
  ok(typeof detail.approvalUrl === 'string' && detail.approvalUrl.includes('approve='),
    'the composer is handed the link to copy');
  ok(detail.approvalUrl.startsWith('http'), 'as an absolute URL built by the server, not the browser',
    detail.approvalUrl.split('/?')[0]);
}

// ---- a post that is already out cannot be sent for approval -------------------------
{
  const P4 = await makePost('E2E-APR the one already gone', 'Out the door.');
  await db.query("UPDATE social_posts SET status = 'published' WHERE id = ?", [P4]);
  const r = await post(`/social/posts/${P4}/request-approval`);
  ok(r.status === 409, 'asking for sign-off on a published post is refused, since no answer could be honoured',
    String(r.status));
}

await clean();
await db.end();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures ? 1 : 0);
