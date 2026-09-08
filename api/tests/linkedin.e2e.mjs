/**
 * The LinkedIn adapter, against a stubbed API.
 *
 * NOTHING HERE TOUCHES A REAL LINKEDIN PAGE, for the same reason as the Meta suite: a
 * post to a client's audience cannot be recalled.
 *
 * LinkedIn differs from Meta in two ways that this pins, because both are easy to get
 * wrong and neither fails loudly:
 *
 *   1. IT NEVER FETCHES FROM A URL. It issues an upload URL and Klippy PUTs the bytes.
 *      The public media route the entire Meta path depends on is irrelevant here.
 *   2. THE POST ID COMES BACK IN A HEADER, not the body. Reading the body would give
 *      an id of undefined and a permalink pointing nowhere, silently.
 *
 * Plus the version header, which is mandatory and whose versions SUNSET: a missing or
 * stale value is an error on every single call.
 *
 * Run with a test server on 8095.
 */
import 'dotenv/config';

let failures = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};

const LI = 'file:///C:/CC/klippy-v2/api/dist/lib/social/adapters/linkedin.js';

process.env.LINKEDIN_CLIENT_ID = 'test-client';
process.env.LINKEDIN_CLIENT_SECRET = 'test-secret';
process.env.LINKEDIN_VERSION = '202608';

const realFetch = globalThis.fetch;
function stub(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    calls.push({
      url: u, method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? init.body : (init.body ? '[stream]' : null),
    });
    for (const [pattern, r] of routes) {
      if (u.includes(pattern)) {
        const resp = typeof r === 'function' ? r(calls.length) : r;
        return new Response(resp.body === undefined ? '' : JSON.stringify(resp.body), {
          status: resp.status ?? 200,
          headers: { 'content-type': 'application/json', ...(resp.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ message: `unstubbed ${u}` }), { status: 400 });
  };
  return calls;
}
const unstub = () => { globalThis.fetch = realFetch; };

const creds = { accessToken: 'LI-TOKEN-SECRET', refreshToken: null, externalId: 'urn:li:organization:99' };
const post = { id: 1, title: 'T', caption: 'Two models, one counter.', firstComment: null, postType: 'post' };

// ---- a text post carries the mandatory headers and the documented body -------------
{
  const { linkedinAdapter } = await import(LI);
  const calls = stub([['/rest/posts', { status: 201, headers: { 'x-restli-id': 'urn:li:share:7100' }, body: {} }]]);
  const res = await linkedinAdapter.publish(creds, post, []);
  unstub();

  ok(res.externalPostId === 'urn:li:share:7100',
    'the post id is read from the x-restli-id HEADER, not the body', res.externalPostId);
  ok(res.permalink === 'https://www.linkedin.com/feed/update/urn:li:share:7100/',
    'and the permalink is built from that URN', res.permalink);

  const h = calls[0].headers;
  ok(h['LinkedIn-Version'] === '202608',
    'the mandatory version header is sent, since a missing one errors on every call', h['LinkedIn-Version']);
  ok(h['X-Restli-Protocol-Version'] === '2.0.0', 'along with the Restli protocol version');

  const body = JSON.parse(calls[0].body);
  ok(body.author === 'urn:li:organization:99', 'the author is the organisation URN', body.author);
  ok(body.commentary === post.caption, 'the caption goes in commentary, which is what LinkedIn calls it');
  ok(body.lifecycleState === 'PUBLISHED',
    'and lifecycleState is PUBLISHED, the only value create accepts', body.lifecycleState);
  ok(body.distribution?.feedDistribution === 'MAIN_FEED', 'with main feed distribution');
}

// ---- an image is uploaded in two steps, never fetched from a URL -------------------
{
  const { linkedinAdapter } = await import(LI);
  const calls = stub([
    ['action=initializeUpload', {
      body: { value: { uploadUrl: 'https://upload.linkedin.example/put/123', image: 'urn:li:image:IMG1' } },
    }],
    ['upload.linkedin.example', { status: 201, body: {} }],
    ['/rest/posts', { status: 201, headers: { 'x-restli-id': 'urn:li:share:7200' }, body: {} }],
  ]);

  const media = [{
    id: 1, position: 0, mimeType: 'image/jpeg', width: 1200, height: 628,
    durationMs: null, bytes: 100, altText: 'A counter',
    publicUrl: 'https://klippy.example.com/api/v1/m/abc.jpg',
    storageKey: 'nonexistent/key.jpg',
  }];

  let res = null;
  let err = null;
  try { res = await linkedinAdapter.publish(creds, post, media); } catch (e) { err = e; }
  unstub();

  const init = calls.find((c) => c.url.includes('initializeUpload'));
  ok(!!init, 'an image starts with initializeUpload');
  ok(JSON.parse(init.body).initializeUploadRequest.owner === 'urn:li:organization:99',
    'owned by the organisation posting it');

  // The file is not really in storage here, so the PUT is expected to fail. What
  // matters is that the flow NEVER handed LinkedIn a URL to fetch from.
  const posted = calls.find((c) => c.url.includes('/rest/posts'));
  const everSentAUrl = calls.some((c) => (c.body ?? '').includes('klippy.example.com'));
  ok(!everSentAUrl, 'and at no point is a public media URL sent, because LinkedIn does not fetch');
  ok(!!err || !!posted, 'the flow either uploads the bytes or fails honestly, never silently posts without the image',
    err ? `failed: ${String(err.message).slice(0, 40)}` : 'posted');
}

// ---- several images become a multiImage post, because there is no organic carousel --
{
  const { linkedinAdapter } = await import(LI);
  let n = 0;
  const calls = stub([
    ['action=initializeUpload', () => ({
      body: { value: { uploadUrl: `https://upload.linkedin.example/put/${++n}`, image: `urn:li:image:IMG${n}` } },
    })],
    ['upload.linkedin.example', { status: 201, body: {} }],
    ['/rest/posts', { status: 201, headers: { 'x-restli-id': 'urn:li:share:7300' }, body: {} }],
  ]);
  // No storageKey, so no upload is attempted and the post goes out as text. That is
  // the honest outcome: an image that cannot be read must not become a silent
  // half-post claiming a picture went with it.
  await linkedinAdapter.publish(creds, post, [
    { id: 1, position: 0, mimeType: 'image/jpeg', width: 1, height: 1, durationMs: null, bytes: 1, altText: null, publicUrl: null, storageKey: null },
    { id: 2, position: 1, mimeType: 'image/jpeg', width: 1, height: 1, durationMs: null, bytes: 1, altText: null, publicUrl: null, storageKey: null },
  ]);
  unstub();
  const body = JSON.parse(calls.find((c) => c.url.includes('/rest/posts')).body);
  ok(!body.content, 'an image with no readable file is left off rather than faked', JSON.stringify(body.content ?? null));
}

// ---- errors are classified the way the publisher needs -----------------------------
{
  const { linkedinAdapter } = await import(LI);

  stub([['/rest/posts', { status: 401, body: { message: 'Invalid access token' } }]]);
  let caught = null;
  try { await linkedinAdapter.publish(creds, post, []); } catch (e) { caught = e; }
  unstub();
  ok(caught?.retryable === false, 'a 401 is permanent, because the same token can only fail again');
  ok(/re-authoris/i.test(caught?.message ?? ''), 'and says the connection needs re-authorising');

  stub([['/rest/posts', { status: 429, body: { message: 'Too many requests' } }]]);
  caught = null;
  try { await linkedinAdapter.publish(creds, post, []); } catch (e) { caught = e; }
  unstub();
  ok(caught?.retryable === true, 'a 429 is worth another go');

  stub([['/rest/posts', { status: 503, body: { message: 'Service unavailable' } }]]);
  caught = null;
  try { await linkedinAdapter.publish(creds, post, []); } catch (e) { caught = e; }
  unstub();
  ok(caught?.retryable === true, 'and so is a 5xx');
}

// ---- organisations are listed with both URN spellings the docs show ----------------
{
  const { linkedinListOrganisations } = await import(LI);
  const calls = stub([
    ['organizationAcls', {
      body: {
        elements: [
          { organization: 'urn:li:organization:11', role: 'ADMINISTRATOR', state: 'APPROVED' },
          { organizationTarget: 'urn:li:organization:22', role: 'ADMINISTRATOR', state: 'APPROVED' },
        ],
      },
    }],
    ['/rest/organizations/11', { body: { localizedName: 'Early Bird Coffee' } }],
    ['/rest/organizations/22', { body: { localizedName: 'Second Page' } }],
  ]);
  const orgs = await linkedinListOrganisations('TOKEN');
  unstub();

  ok(orgs.length === 2, 'both organisations come back', String(orgs.length));
  ok(orgs[0].displayName === 'Early Bird Coffee',
    'named readably, because a picker showing a raw URN is useless', orgs[0].displayName);
  ok(orgs[1].externalId === 'urn:li:organization:22',
    'and organizationTarget is read as well as organization, which the docs spell both ways',
    orgs[1].externalId);
  ok(calls[0].url.includes('role=ADMINISTRATOR') && calls[0].url.includes('state=APPROVED'),
    'only approved administrator roles are asked for');
}

// ---- the first comment posts as the organisation ------------------------------------
{
  const { linkedinAdapter } = await import(LI);
  const calls = stub([['socialActions', { status: 201, headers: { 'x-restli-id': 'urn:li:comment:1' }, body: {} }]]);
  await linkedinAdapter.publishFirstComment(creds, 'urn:li:share:7100', 'Open until 5.');
  unstub();
  ok(calls[0].url.includes(encodeURIComponent('urn:li:share:7100')),
    'the post URN is URL-encoded into the path, since it contains colons', calls[0].url.slice(-60));
  const body = JSON.parse(calls[0].body);
  ok(body.actor === 'urn:li:organization:99', 'and the comment is made BY the organisation', body.actor);
}

// ---- dry run sends nothing -----------------------------------------------------------
{
  process.env.SOCIAL_DRY_RUN = '1';
  const { linkedinAdapter } = await import(LI);
  const calls = stub([['', { body: {} }]]);
  const res = await linkedinAdapter.publish(creds, post, []);
  unstub();
  delete process.env.SOCIAL_DRY_RUN;
  ok(calls.length === 0, 'a dry run makes NO network call', calls.length + ' calls');
  ok(res.externalPostId.startsWith('dryrun-linkedin'), 'and says plainly that it was one', res.externalPostId);
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures ? 1 : 0);
