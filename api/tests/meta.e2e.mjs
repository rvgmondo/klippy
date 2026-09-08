/**
 * The Meta adapter, against a stubbed Graph API.
 *
 * NOTHING HERE TOUCHES A REAL FACEBOOK PAGE. Publishing is the one action in Klippy
 * that cannot be undone, so the adapter is proved against responses in the shape
 * Meta's own reference documents, with fetch replaced. If Meta changes that shape,
 * this is the test that should fail first.
 *
 * What it proves:
 *   1. Instagram is a THREE-step publish, not one: create a container, wait for Meta
 *      to fetch the file, then publish. Publishing without waiting is how a post fails
 *      with "media not ready" at the exact moment nobody is watching.
 *   2. Retryable and permanent failures are told apart correctly, on CODES not on
 *      message text. Getting this wrong burns quota one way and silently drops a
 *      client's post the other.
 *   3. A token never reaches a log or an error detail, even when the failure is about
 *      the token.
 *   4. Dry run sends nothing at all.
 *
 * Run with a test server on 8095.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

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

const M = 'file:///C:/CC/klippy-v2/api/dist/lib/social/adapters/meta.js';
const HTTP = 'file:///C:/CC/klippy-v2/api/dist/lib/social/http.js';
const TOKENS = 'file:///C:/CC/klippy-v2/api/dist/lib/social/tokens.js';

process.env.META_APP_ID = 'test-app';
process.env.META_APP_SECRET = 'test-secret';
process.env.META_POLL_INTERVAL_MS = '5';
process.env.PUBLIC_MEDIA_BASE = 'https://klippy.example.com';

const realFetch = globalThis.fetch;
/** Replace fetch with a scripted Graph API. Returns the calls it saw. */
function stub(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body ? String(init.body) : null });
    for (const [pattern, responder] of routes) {
      if (u.includes(pattern)) {
        const r = typeof responder === 'function' ? responder(calls.length, u) : responder;
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200, headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: { message: `unstubbed ${u}`, code: 999 } }), { status: 400 });
  };
  return calls;
}
const unstub = () => { globalThis.fetch = realFetch; };

const media = [{
  id: 1, position: 0, mimeType: 'image/jpeg', width: 1080, height: 1080,
  durationMs: null, bytes: 200000, altText: 'A coffee',
  publicUrl: 'https://klippy.example.com/api/v1/m/abc.jpg',
}];
const post = { id: 1, title: 'T', caption: 'Iced season is back.', firstComment: null, postType: 'post' };
const creds = { accessToken: 'PAGE-TOKEN-SECRET', refreshToken: null, externalId: '17841400000000000' };

// ---- Instagram publishes in three steps, and waits in the middle -------------------
{
  const { instagramAdapter } = await import(M);
  let statusCalls = 0;
  const calls = stub([
    ['/media_publish', { body: { id: 'IG_MEDIA_1' } }],
    ['/media', { body: { id: 'IG_CONTAINER_1' } }],
    // IN_PROGRESS first, then FINISHED: exactly what Meta does while it fetches.
    ['fields=status_code', () => {
      statusCalls++;
      return { body: statusCalls < 2 ? { status_code: 'IN_PROGRESS' } : { status_code: 'FINISHED' } };
    }],
    ['fields=permalink', { body: { permalink: 'https://www.instagram.com/p/XYZ/' } }],
  ]);

  const res = await instagramAdapter.publish(creds, post, media);
  unstub();

  ok(res.externalPostId === 'IG_MEDIA_1', 'Instagram returns the published media id', res.externalPostId);
  ok(res.permalink?.includes('instagram.com'), 'and the permalink is FETCHED, not guessed from a shortcode', res.permalink);
  ok(statusCalls >= 2, 'the container is polled until Meta says FINISHED', statusCalls + ' status calls');

  const order = calls.map((c) => (c.url.includes('media_publish') ? 'publish'
    : c.url.includes('status_code') ? 'poll'
      : c.url.includes('permalink') ? 'permalink' : 'create'));
  ok(order[0] === 'create' && order.includes('poll') && order.indexOf('publish') > order.indexOf('poll'),
    'and publish happens only AFTER the wait, never before', order.join(' > '));

  const createCall = calls.find((c) => c.method === 'POST' && !c.url.includes('media_publish'));
  ok(/image_url=/.test(createCall.body ?? ''), 'the container is given a public URL, because Meta fetches the file itself');
}

// ---- a carousel is children first, then a parent -----------------------------------
{
  const { instagramAdapter } = await import(M);
  let n = 0;
  const calls = stub([
    ['/media_publish', { body: { id: 'IG_MEDIA_2' } }],
    ['/media', () => ({ body: { id: `CONTAINER_${++n}` } })],
    ['fields=status_code', { body: { status_code: 'FINISHED' } }],
    ['fields=permalink', { body: { permalink: 'https://www.instagram.com/p/CAR/' } }],
  ]);

  const two = [media[0], { ...media[0], id: 2, position: 1, publicUrl: 'https://klippy.example.com/api/v1/m/def.jpg' }];
  await instagramAdapter.publish(creds, { ...post, postType: 'carousel' }, two);
  unstub();

  const creates = calls.filter((c) => c.method === 'POST' && c.url.includes('/media') && !c.url.includes('publish'));
  ok(creates.length === 3, 'two children and one parent container', creates.length + ' create calls');
  ok(creates.slice(0, 2).every((c) => /is_carousel_item=true/.test(c.body ?? '')), 'each child is flagged as a carousel item');
  const parent = creates[2];
  ok(/media_type=CAROUSEL/.test(parent.body ?? ''), 'and the parent is a CAROUSEL');
  ok(/children=CONTAINER_1%2CCONTAINER_2/.test(parent.body ?? ''),
    'carrying the children in order, because Instagram crops them all to the first');
}

// ---- every Instagram video is a Reel ------------------------------------------------
{
  const { instagramAdapter } = await import(M);
  const calls = stub([
    ['/media_publish', { body: { id: 'IG_MEDIA_3' } }],
    ['/media', { body: { id: 'CONTAINER_V' } }],
    ['fields=status_code', { body: { status_code: 'FINISHED' } }],
    ['fields=permalink', { body: { permalink: 'https://www.instagram.com/reel/V/' } }],
  ]);
  await instagramAdapter.publish(creds, post, [{
    ...media[0], mimeType: 'video/mp4', durationMs: 15000,
    publicUrl: 'https://klippy.example.com/api/v1/m/vid.mp4',
  }]);
  unstub();
  const create = calls.find((c) => c.method === 'POST');
  ok(/media_type=REELS/.test(create.body ?? ''),
    'a video posts as a Reel, because Instagram dropped plain feed video in 2023');
  ok(/video_url=/.test(create.body ?? ''), 'with a video URL rather than an upload');
}

// ---- retryable and permanent are told apart, on codes ------------------------------
{
  const { classifyMetaError } = await import(HTTP);

  const rate = classifyMetaError({ error: { code: 4, message: 'Application request limit reached' } }, 400);
  ok(rate.retryable === true, 'a rate limit is retryable', rate.code);

  const expired = classifyMetaError({ error: { code: 190, error_subcode: 463, message: 'expired' } }, 400);
  ok(expired.retryable === false, 'an expired token is NOT retried, because the same token can only fail again', expired.code);
  ok(/re-authoris/i.test(expired.message), 'and the message says what to do about it');

  const spam = classifyMetaError({ error: { code: 4, error_subcode: 2207051, message: 'restricted' } }, 400);
  ok(spam.retryable === false, 'the Instagram spam guard is never retried, since retrying makes it worse', spam.code);

  const transient = classifyMetaError({ error: { code: 100, is_transient: true, message: 'odd' } }, 400);
  ok(transient.retryable === true, 'and is_transient is believed whatever the code says');

  const tooLong = classifyMetaError({ error: { code: 36004, error_subcode: 2207010, message: 'caption too long' } }, 400);
  ok(tooLong.retryable === false, 'a caption that is too long is permanent, not something to retry at', tooLong.code);

  const slow = classifyMetaError({ error: { code: -2, error_subcode: 2207003, message: 'too long to download' } }, 400);
  ok(slow.retryable === true, 'a slow media fetch is worth another go', slow.code);
}

// ---- a token never leaks, even when the error is about the token -------------------
{
  const { scrubUrl } = await import(HTTP);
  const { redact } = await import(TOKENS);

  const scrubbed = scrubUrl('https://graph.facebook.com/v26.0/me?access_token=SECRET123&fields=id');
  ok(!scrubbed.includes('SECRET123'), 'a Graph URL is scrubbed before it can be logged', scrubbed.slice(-40));

  const r = redact({ access_token: 'SECRET', nested: { client_secret: 'SECRET' }, fine: 'hello' });
  ok(r.access_token === '[redacted]' && r.nested.client_secret === '[redacted]',
    'and token-shaped keys are blanked at any depth');
  ok(r.fine === 'hello', 'while ordinary values are left readable, so the log is still useful');

  const long = redact({ whatever: 'a'.repeat(120) });
  ok(String(long.whatever).startsWith('[redacted'),
    'a long opaque string is blanked even under a key nobody thought to list');
}

// ---- an error carries no credential in its detail -----------------------------------
{
  const { instagramAdapter } = await import(M);
  stub([['/media', { status: 400, body: { error: { code: 190, error_subcode: 463, message: 'Session expired' } } }]]);
  let caught = null;
  try {
    await instagramAdapter.publish(creds, post, media);
  } catch (err) { caught = err; }
  unstub();

  ok(caught && caught.retryable === false, 'an expired token surfaces as a permanent failure');
  const dumped = JSON.stringify(caught?.detail ?? {});
  ok(!dumped.includes('PAGE-TOKEN-SECRET'),
    'and the error detail the UI stores contains no token at all', dumped.slice(0, 60));
}

// ---- dry run sends nothing ----------------------------------------------------------
{
  process.env.SOCIAL_DRY_RUN = '1';
  const { instagramAdapter } = await import(M);
  const calls = stub([['', { body: {} }]]);
  const res = await instagramAdapter.publish(creds, post, media);
  unstub();
  delete process.env.SOCIAL_DRY_RUN;

  ok(calls.length === 0, 'a dry run makes NO network call at all', calls.length + ' calls');
  ok(res.externalPostId.startsWith('dryrun-'), 'and returns a fake id it is obvious about', res.externalPostId);
}

// ---- Facebook posts a photo with a caption, and words alone ------------------------
{
  const { facebookAdapter } = await import(M);
  let calls = stub([['/photos', { body: { id: 'PHOTO_1', post_id: 'PAGE_POST_1' } }]]);
  const withPhoto = await facebookAdapter.publish({ ...creds, externalId: '999' }, post, media);
  unstub();
  ok(withPhoto.externalPostId === 'PAGE_POST_1',
    'a Facebook photo post returns the POST id, not the photo id', withPhoto.externalPostId);
  ok(/caption=/.test(calls[0].body ?? ''), 'with the caption, since message is deprecated on /photos');

  calls = stub([['/feed', { body: { id: 'PAGE_POST_2' } }]]);
  await facebookAdapter.publish({ ...creds, externalId: '999' }, post, []);
  unstub();
  ok(calls[0].url.includes('/feed'), 'and words alone go to /feed instead');
}

// ---- media Meta cannot reach is refused with a useful reason -----------------------
{
  const { instagramAdapter } = await import(M);
  stub([['', { body: {} }]]);
  let caught = null;
  try {
    await instagramAdapter.publish(creds, post, [{ ...media[0], publicUrl: 'http://localhost:5173/api/v1/m/x.jpg' }]);
  } catch (err) { caught = err; }
  unstub();
  ok(caught && /PUBLIC_MEDIA_BASE/.test(caught.message),
    'a localhost media URL is caught before calling Meta, and names the setting to fix', caught?.message.slice(0, 70));
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
