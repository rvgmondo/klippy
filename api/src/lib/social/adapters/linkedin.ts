import { validatePost } from '../validate.js';
import { storage } from '../../storage.js';
import {
  SocialApiError, dryRun,
  type AdapterCredentials, type ConnectedAccount, type MediaItem,
  type PublishablePost, type PublishResult, type SocialAdapter, type ValidationResult,
} from '../types.js';
import { redact } from '../tokens.js';

/**
 * LinkedIn organisation pages.
 *
 * DIFFERENT FROM META IN THE ONE WAY THAT MATTERS TO THIS CODEBASE: LinkedIn never
 * fetches media from a URL. It hands you an upload URL and you PUT the bytes yourself
 * (LI-UP-02). So the public media route the whole Meta path depends on is irrelevant
 * here, and this adapter reads the file out of storage and streams it. That single
 * difference is why the adapter interface takes MediaItem rather than a URL.
 *
 * THE OTHER DIFFERENCE IS BUREAUCRATIC AND WORSE. Every organisation action needs the
 * Community Management API, which is an application to LinkedIn that takes time and
 * cannot even be requested on an app that already has other products (LI-AUTH-17). So
 * this adapter can be complete and correct and still not usable, and the honest
 * behaviour while that is true is the manual path, not an error.
 *
 * Rows cited throughout are docs/social/API-NOTES.md.
 */

const REST = 'https://api.linkedin.com/rest';
/**
 * LI-AUTH-07 and LI-AUTH-08. The version header is mandatory and versions SUNSET.
 *
 * Pinned in config, not floating, because a missing or deprecated value is an error on
 * every call. 202608 is supported until August 2027; this needs a yearly bump, which is
 * why it reads from the environment rather than being buried in a string.
 */
const VERSION = process.env.LINKEDIN_VERSION || '202608';

const clientId = () => process.env.LINKEDIN_CLIENT_ID ?? '';
const clientSecret = () => process.env.LINKEDIN_CLIENT_SECRET ?? '';
export const linkedinConfigured = (): boolean => !!(clientId() && clientSecret());

/** LI-POST-03. Everything an organisation post needs, plus comments and the profile. */
const SCOPES = [
  'openid', 'profile',
  'w_member_social',
  'w_organization_social', 'w_organization_social_feed',
  'r_organization_social', 'rw_organization_admin',
].join(' ');

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': VERSION,
    ...extra,
  };
}

/**
 * LinkedIn's error shape, turned into the same decision Meta's is.
 *
 * Different fields, same question. 429 and 5xx are worth another go; 401 and 403 mean
 * the token or the Page role is gone and retrying can only fail identically.
 */
function linkedinError(status: number, body: unknown): SocialApiError {
  const b = body as { message?: string; serviceErrorCode?: number; code?: string } | null;
  const message = b?.message ?? `LinkedIn returned HTTP ${status}`;
  const retryable = status === 429 || status >= 500;
  const authGone = status === 401 || status === 403;
  return new SocialApiError('linkedin',
    authGone ? `${message} The LinkedIn connection needs to be re-authorised.` : message,
    {
      retryable,
      code: b?.serviceErrorCode ? String(b.serviceErrorCode) : String(status),
      detail: redact({ status, body }),
    });
}

async function call<T = unknown>(
  url: string,
  init: RequestInit & { token: string; timeoutMs?: number },
): Promise<{ body: T; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new SocialApiError('linkedin',
      aborted ? 'LinkedIn did not answer in time.' : 'Could not reach LinkedIn.',
      { retryable: true, code: aborted ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text ? { raw: text.slice(0, 400) } : null; }
  if (!res.ok) throw linkedinError(res.status, body);
  return { body: body as T, headers: res.headers };
}

// ---- OAuth ---------------------------------------------------------------------

/** LI-AUTH-01. */
export function linkedinAuthUrl(state: string, redirectUri: string): string {
  return `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({
    response_type: 'code', client_id: clientId(), redirect_uri: redirectUri, state, scope: SCOPES,
  })}`;
}

/**
 * LI-AUTH-02. Code for a token.
 *
 * refresh_token comes back ONLY for apps LinkedIn has enabled for programmatic
 * refresh, which is a limited set of partners. For everyone else the token simply
 * expires after sixty days and a person has to reconnect in a browser, so its absence
 * is recorded rather than treated as a failure: the daily health check is what turns
 * that into a warning before it turns into a missed post.
 */
export async function linkedinExchangeCode(code: string, redirectUri: string): Promise<{
  accessToken: string; refreshToken: string | null; expiresAt: Date | null; scopes: string[];
}> {
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri,
    }),
  });
  const body = await res.json().catch(() => null) as {
    access_token?: string; expires_in?: number; refresh_token?: string; scope?: string;
  } | null;
  if (!res.ok || !body?.access_token) throw linkedinError(res.status, body);

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    scopes: body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : [],
  };
}

/**
 * LI-AUTH-21 and LI-AUTH-30. Organisations this member administers.
 *
 * Two quirks from the docs are handled rather than assumed away: the org URN appears
 * as `organization` in one sample and `organizationTarget` in others, so both are read;
 * and the role enum is ADMINISTRATOR here while the Posts API gates on CONTENT_ADMIN,
 * which the notes flag as a naming inconsistency rather than two different things.
 */
export async function linkedinListOrganisations(token: string): Promise<ConnectedAccount[]> {
  const { body } = await call<{
    elements?: { organization?: string; organizationTarget?: string; role?: string; state?: string }[];
  }>(`${REST}/organizationAcls?${new URLSearchParams({
    q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED', count: '20',
  })}`, { method: 'GET', headers: headers(token), token });

  const urns = (body.elements ?? [])
    .map((e) => e.organization ?? e.organizationTarget)
    .filter((u): u is string => !!u);
  if (!urns.length) return [];

  // The ACL list gives URNs and nothing readable, so the names are fetched separately.
  // A picker showing "urn:li:organization:12345" is a picker nobody can use.
  const out: ConnectedAccount[] = [];
  for (const urn of urns) {
    const id = urn.split(':').pop() ?? '';
    let name = urn;
    let logo: string | null = null;
    try {
      const { body: org } = await call<{ localizedName?: string; vanityName?: string }>(
        `${REST}/organizations/${id}`, { method: 'GET', headers: headers(token), token });
      name = org.localizedName ?? org.vanityName ?? urn;
    } catch { /* an unreadable name must not hide a connectable page */ }
    out.push({ network: 'linkedin', externalId: urn, displayName: name, avatarUrl: logo });
  }
  return out;
}

// ---- Publishing ------------------------------------------------------------------

/**
 * LI-UP-01 and LI-UP-02. Upload an image, in two steps.
 *
 * LinkedIn issues an upload URL and Klippy PUTs the bytes to it. Note the asymmetry the
 * docs call out: the IMAGE upload requires the Authorization header, while the video
 * upload refuses one. Getting that backwards is a 401 with a confusing message.
 */
async function uploadImage(token: string, owner: string, storageKey: string): Promise<string> {
  const { body } = await call<{ value?: { uploadUrl?: string; image?: string } }>(
    `${REST}/images?action=initializeUpload`, {
      method: 'POST',
      headers: headers(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
      token,
    });

  const uploadUrl = body.value?.uploadUrl;
  const imageUrn = body.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new SocialApiError('linkedin', 'LinkedIn did not return an upload URL.',
      { retryable: true, code: 'no-upload-url' });
  }

  const size = await storage().size(storageKey);
  if (size == null) {
    throw new SocialApiError('linkedin', 'The image file is missing from storage.',
      { retryable: false, code: 'missing-file' });
  }

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'content-length': String(size) },
    // Node's fetch accepts a Readable as a body; the cast is because the DOM lib's
    // BodyInit does not know about Node streams.
    body: storage().createReadStream(storageKey) as unknown as ReadableStream,
    // Node needs this to stream a body rather than buffering it, and without it the
    // request fails outright on a file of any size.
    duplex: 'half',
  } as RequestInit & { duplex: string });

  if (!res.ok) {
    throw linkedinError(res.status, await res.json().catch(() => null));
  }
  return imageUrn;
}

/** LI-POST-01, LI-POST-02, LI-POST-04. */
async function publishLinkedIn(
  creds: AdapterCredentials, post: PublishablePost, media: MediaItem[],
): Promise<PublishResult> {
  const token = creds.accessToken;
  const author = creds.externalId.startsWith('urn:') ? creds.externalId : `urn:li:organization:${creds.externalId}`;

  const images: { id: string; altText?: string }[] = [];
  for (const m of media.filter((x) => (x.mimeType ?? '').startsWith('image/'))) {
    if (!m.storageKey) continue;
    images.push({ id: await uploadImage(token, author, m.storageKey), ...(m.altText ? { altText: m.altText } : {}) });
  }

  const body: Record<string, unknown> = {
    author,
    commentary: post.caption ?? '',
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (images.length === 1) {
    body.content = { media: { id: images[0]!.id, ...(images[0]!.altText ? { altText: images[0]!.altText } : {}) } };
  } else if (images.length > 1) {
    // LI-POST-05: LinkedIn has no organic carousel. Several images are a multiImage
    // post, which is a different thing and the only organic option.
    body.content = { multiImage: { images: images.map((i) => ({ id: i.id, ...(i.altText ? { altText: i.altText } : {}) })) } };
  }

  const { headers: resHeaders } = await call(`${REST}/posts`, {
    method: 'POST',
    headers: headers(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    token,
  });

  // LI-POST-01: the post URN comes back in a HEADER, not the body.
  const urn = resHeaders.get('x-restli-id');
  if (!urn) {
    throw new SocialApiError('linkedin', 'LinkedIn accepted the post but returned no id.',
      { retryable: false, code: 'no-restli-id' });
  }
  return { externalPostId: urn, permalink: `https://www.linkedin.com/feed/update/${urn}/` };
}

export const linkedinAdapter: SocialAdapter = {
  network: 'linkedin',
  canPublish: linkedinConfigured(),

  authUrl(state: string) {
    return linkedinAuthUrl(state, `${process.env.APP_URL ?? ''}/api/v1/social/connect/linkedin/callback`);
  },

  async exchangeCode(code: string) {
    const r = await linkedinExchangeCode(code, `${process.env.APP_URL ?? ''}/api/v1/social/connect/linkedin/callback`);
    return {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken ?? undefined,
      expiresAt: r.expiresAt ?? undefined,
      scopes: r.scopes,
    };
  },

  listPublishableAccounts(userToken: string) {
    return linkedinListOrganisations(userToken);
  },

  validate(post: PublishablePost, media: MediaItem[]): ValidationResult {
    return validatePost(post, media, ['linkedin']);
  },

  async publish(creds, post, media): Promise<PublishResult> {
    if (dryRun()) {
      // eslint-disable-next-line no-console
      console.log(`[SOCIAL_DRY_RUN] publish:linkedin ${JSON.stringify({
        author: creds.externalId, captionChars: (post.caption ?? '').length,
        images: media.filter((m) => (m.mimeType ?? '').startsWith('image/')).length,
      })}`);
      return { externalPostId: `dryrun-linkedin-${Date.now()}`, permalink: null };
    }
    if (!linkedinConfigured()) {
      throw new SocialApiError('linkedin',
        'LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are not set on the server.',
        { retryable: false, code: 'not-configured' });
    }
    return publishLinkedIn(creds, post, media);
  },

  async publishFirstComment(creds, externalPostId, text) {
    if (dryRun()) return;
    const author = creds.externalId.startsWith('urn:') ? creds.externalId : `urn:li:organization:${creds.externalId}`;
    // LI-POST-17. The URN goes in the path and must be encoded: it contains colons.
    await call(`${REST}/socialActions/${encodeURIComponent(externalPostId)}/comments`, {
      method: 'POST',
      headers: headers(creds.accessToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ actor: author, object: externalPostId, message: { text } }),
      token: creds.accessToken,
    });
  },
};
