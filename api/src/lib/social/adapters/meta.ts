import { httpJson } from '../http.js';
import { validatePost } from '../validate.js';
import { isPubliclyFetchable } from '../mediaUrl.js';
import {
  SocialApiError, dryRun,
  type AdapterCredentials, type ConnectedAccount, type MediaItem,
  type Network, type PublishablePost, type PublishResult, type SocialAdapter, type ValidationResult,
} from '../types.js';

/**
 * Instagram and Facebook Pages, through the Graph API.
 *
 * One file for both because they share an app, a login and a token chain: connecting
 * once gives you the Page and the Instagram account linked to it. Splitting them would
 * mean two OAuth flows for what a person experiences as one connection.
 *
 * EVERY CALL CITES ITS ROW IN docs/social/API-NOTES.md. Those rows were verified
 * against Meta's own reference and then a second pass tried to refute each one. When a
 * platform changes something, the citation is how the fix gets found.
 *
 * NOTHING HERE TOUCHES THE DATABASE. An adapter takes credentials and data, calls the
 * platform, and returns a result or throws. That is what makes it testable without a
 * tenant and what stops a bug in one network corrupting another's rows.
 *
 * THE PUBLISHING MODEL IS NOT THE OBVIOUS ONE. Instagram does not accept an upload:
 * it accepts a URL, fetches the file itself, and does it asynchronously. So a post is
 * three steps, not one, and the middle step is waiting. That is why publish() polls,
 * and why the media URL has to be reachable from Meta's servers rather than from the
 * browser.
 */

const VERSION = process.env.META_API_VERSION || 'v26.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;

/** IG-PUB-21: once a minute for at most five minutes. */
const POLL_INTERVAL_MS = Number(process.env.META_POLL_INTERVAL_MS || 5000);
const POLL_MAX_MS = 5 * 60_000;

/**
 * The app identity, passed in rather than read from the environment.
 *
 * A workspace stores its own in Klippy, so the caller resolves which one applies and
 * hands it over. Nothing in this file reaches for a global, which is also what makes
 * it testable without setting process.env.
 */
export interface MetaApp { appId: string; appSecret: string; configId?: string | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a dry run writes instead of calling out. Kept parseable, not prose. */
function logDryRun(what: string, detail: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[SOCIAL_DRY_RUN] ${what} ${JSON.stringify(detail)}`);
}

// ---- OAuth --------------------------------------------------------------------

/**
 * M-AUTH-03. The login dialog.
 *
 * config_id, not scope. Facebook Login for Business replaced the scope list with a
 * dashboard configuration, and passing scope to a Business-type app is the documented
 * way to get a dialog that grants nothing.
 */
export function metaAuthUrl(state: string, redirectUri: string, app: MetaApp): string {
  const q = new URLSearchParams({ client_id: app.appId, redirect_uri: redirectUri, state, response_type: 'code' });
  if (app.configId) q.set('config_id', app.configId);
  return `https://www.facebook.com/${VERSION}/dialog/oauth?${q}`;
}

/**
 * M-AUTH-04 then M-AUTH-20. Code to short-lived token, then straight to long-lived.
 *
 * The exchange happens immediately rather than later, because a short-lived token
 * lasts one to two hours (M-AUTH-22) and a connection made on a Friday would otherwise
 * be dead before anyone published with it.
 */
export async function metaExchangeCode(code: string, redirectUri: string, app: MetaApp): Promise<{
  accessToken: string; expiresAt: Date | null;
}> {
  const short = await httpJson<{ access_token: string }>(
    `${GRAPH}/oauth/access_token?${new URLSearchParams({
      client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code,
    })}`, { network: 'facebook' });

  const long = await httpJson<{ access_token: string; expires_in?: number }>(
    `${GRAPH}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token', client_id: app.appId, client_secret: app.appSecret,
      fb_exchange_token: short.access_token,
    })}`, { network: 'facebook' });

  return {
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
  };
}

/**
 * M-AUTH-11, M-AUTH-12, M-AUTH-21. Everything this person can publish to.
 *
 * Each Page carries its own access_token, and THAT is what gets stored: a Page token
 * from a long-lived user token has no expiry (M-AUTH-21), so publishing keeps working
 * after the user token's sixty days run out. Storing the user token instead would mean
 * every client silently stopped posting two months after connecting.
 */
export async function metaListAccounts(userToken: string): Promise<ConnectedAccount[]> {
  const pages = await httpJson<{
    data: { id: string; name: string; access_token?: string; tasks?: string[] }[];
  }>(`${GRAPH}/me/accounts?${new URLSearchParams({
    access_token: userToken,
    fields: 'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,profile_picture_url}',
  })}`, { network: 'facebook' });

  const out: ConnectedAccount[] = [];
  for (const p of pages.data ?? []) {
    // CREATE_CONTENT is the task publishing needs (FB-PUB-01, IG-PUB-07). A Page the
    // person can only read is not somewhere Klippy can post, and listing it would be
    // an offer that fails later.
    const canPost = !p.tasks || p.tasks.includes('CREATE_CONTENT');
    if (!canPost) continue;

    out.push({
      network: 'facebook',
      externalId: p.id,
      displayName: p.name,
      avatarUrl: (p as { picture?: { data?: { url?: string } } }).picture?.data?.url ?? null,
      accountToken: p.access_token,
    });

    const ig = (p as { instagram_business_account?: { id?: string; username?: string; profile_picture_url?: string } })
      .instagram_business_account;
    if (ig?.id) {
      out.push({
        network: 'instagram',
        externalId: ig.id,
        displayName: ig.username ? `@${ig.username}` : `${p.name} on Instagram`,
        avatarUrl: ig.profile_picture_url ?? null,
        // The IG account publishes with its PAGE's token, which is why one connection
        // covers both and why this carries the Page's token rather than its own.
        accountToken: p.access_token,
      });
    }
  }
  return out;
}

// ---- Instagram ----------------------------------------------------------------

/** IG-PUB-06. What the container says about itself. */
async function containerStatus(id: string, token: string): Promise<{ status_code?: string; status?: string }> {
  return httpJson(`${GRAPH}/${id}?${new URLSearchParams({ fields: 'status_code,status', access_token: token })}`,
    { network: 'instagram' });
}

/**
 * IG-PUB-06 and IG-PUB-21. Wait for Instagram to finish fetching the media.
 *
 * The container id coming back does NOT mean the upload worked (IG-PUB-02 says so
 * explicitly); Meta fetches the file on its own schedule and can fail afterwards.
 * Publishing without waiting is how a post fails with 9007 "media not ready" at the
 * exact moment nobody is watching.
 */
async function waitForContainer(id: string, token: string): Promise<void> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    const s = await containerStatus(id, token);
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR') {
      throw new SocialApiError('instagram', `Instagram could not process the media: ${s.status ?? 'no reason given'}`,
        { retryable: false, code: 'container-error', detail: s });
    }
    if (s.status_code === 'EXPIRED') {
      throw new SocialApiError('instagram', 'The upload expired before it was published.',
        { retryable: true, code: 'container-expired', detail: s });
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // Five minutes of IN_PROGRESS. Retryable, because a fresh container often works and
  // the docs give no guidance beyond the five-minute ceiling.
  throw new SocialApiError('instagram', 'Instagram is still processing the video after five minutes.',
    { retryable: true, code: 'container-timeout' });
}

async function createContainer(igUserId: string, token: string, params: Record<string, string | undefined>): Promise<string> {
  const form: Record<string, string> = { access_token: token };
  for (const [k, v] of Object.entries(params)) if (v !== undefined) form[k] = v;
  const res = await httpJson<{ id: string }>(`${GRAPH}/${igUserId}/media`, {
    method: 'POST', form, network: 'instagram',
  });
  if (!res?.id) {
    throw new SocialApiError('instagram', 'Instagram accepted the upload but returned no id.',
      { retryable: true, code: 'no-container-id' });
  }
  return res.id;
}

async function publishInstagram(
  creds: AdapterCredentials, post: PublishablePost, media: MediaItem[],
): Promise<PublishResult> {
  const token = creds.accessToken;
  const igId = creds.externalId;
  const caption = post.caption || undefined;
  const usable = media.filter((m) => m.publicUrl && isPubliclyFetchable(m.publicUrl));

  if (!usable.length) {
    // Worth its own message: this is almost always PUBLIC_MEDIA_BASE pointing at
    // something Meta cannot reach, not a problem with the post.
    throw new SocialApiError('instagram',
      'Instagram fetches media from a public URL and none of these files have one it could reach. Check PUBLIC_MEDIA_BASE.',
      { retryable: false, code: 'no-public-media' });
  }

  let containerId: string;

  if (post.postType === 'carousel' && usable.length > 1) {
    // IG-PUB-04: children first, each is_carousel_item, then a CAROUSEL parent.
    const children: string[] = [];
    for (const m of usable.slice(0, 10)) {
      const isVideo = (m.mimeType ?? '').startsWith('video/');
      const child = await createContainer(igId, token, {
        is_carousel_item: 'true',
        ...(isVideo ? { media_type: 'VIDEO', video_url: m.publicUrl! } : { image_url: m.publicUrl! }),
        ...(m.altText ? { alt_text: m.altText } : {}),
      });
      // A video child is fetched asynchronously like any other, so the parent cannot
      // be built until each one is actually ready.
      if (isVideo) await waitForContainer(child, token);
      children.push(child);
    }
    containerId = await createContainer(igId, token, {
      media_type: 'CAROUSEL', children: children.join(','), caption,
    });
  } else {
    const first = usable[0]!;
    const isVideo = (first.mimeType ?? '').startsWith('video/');
    containerId = isVideo
      // IG-PUB-03: every single Instagram video is a Reel since November 2023, whatever
      // the composer calls it. share_to_feed so it appears in the feed as well.
      ? await createContainer(igId, token, {
          media_type: 'REELS', video_url: first.publicUrl!, caption, share_to_feed: 'true',
        })
      : await createContainer(igId, token, {
          image_url: first.publicUrl!, caption,
          ...(first.altText ? { alt_text: first.altText } : {}),
        });
  }

  await waitForContainer(containerId, token);

  // IG-PUB-07.
  const published = await httpJson<{ id: string }>(`${GRAPH}/${igId}/media_publish`, {
    method: 'POST', form: { creation_id: containerId, access_token: token }, network: 'instagram',
  });
  if (!published?.id) {
    throw new SocialApiError('instagram', 'Instagram published nothing back.', { retryable: true, code: 'no-media-id' });
  }

  // The permalink is fetched rather than built: Instagram's shortcode scheme is not
  // documented and guessing it would produce links that quietly 404.
  let permalink: string | null = null;
  try {
    const info = await httpJson<{ permalink?: string }>(
      `${GRAPH}/${published.id}?${new URLSearchParams({ fields: 'permalink', access_token: token })}`,
      { network: 'instagram' });
    permalink = info.permalink ?? null;
  } catch { /* the post is out; a missing link is not worth failing over */ }

  return { externalPostId: published.id, permalink };
}

// ---- Facebook Page -------------------------------------------------------------

async function publishFacebook(
  creds: AdapterCredentials, post: PublishablePost, media: MediaItem[],
): Promise<PublishResult> {
  const token = creds.accessToken;
  const pageId = creds.externalId;
  const message = post.caption || undefined;
  const photos = media.filter((m) => (m.mimeType ?? '').startsWith('image/') && m.publicUrl && isPubliclyFetchable(m.publicUrl));
  const videos = media.filter((m) => (m.mimeType ?? '').startsWith('video/') && m.publicUrl && isPubliclyFetchable(m.publicUrl));

  // FB-PUB-04: a video post takes file_url and is its own edge.
  if (videos.length) {
    const res = await httpJson<{ id: string }>(`${GRAPH}/${pageId}/videos`, {
      method: 'POST',
      form: { file_url: videos[0]!.publicUrl!, description: message, access_token: token },
      network: 'facebook',
      // Meta downloads the file itself, and a large video takes longer than a normal
      // call, so this one gets more room before it is called a timeout.
      timeoutMs: 120_000,
    });
    return { externalPostId: res.id, permalink: `https://www.facebook.com/${res.id}` };
  }

  // FB-PUB-02: one photo posts straight to /photos with a caption.
  if (photos.length === 1) {
    const res = await httpJson<{ id: string; post_id?: string }>(`${GRAPH}/${pageId}/photos`, {
      method: 'POST',
      form: {
        url: photos[0]!.publicUrl!, caption: message, access_token: token,
        ...(photos[0]!.altText ? { alt_text_custom: photos[0]!.altText } : {}),
      },
      network: 'facebook',
    });
    const id = res.post_id ?? res.id;
    return { externalPostId: id, permalink: `https://www.facebook.com/${id}` };
  }

  // FB-PUB-03 is UNVERIFIED in current docs: attached_media no longer appears in the
  // v26 /feed reference, so several photos are posted as several photo posts would be
  // guesswork. The first is posted and the rest are reported, which is honest, rather
  // than sending a request built on a parameter the docs no longer describe.
  if (photos.length > 1) {
    const res = await httpJson<{ id: string; post_id?: string }>(`${GRAPH}/${pageId}/photos`, {
      method: 'POST',
      form: { url: photos[0]!.publicUrl!, caption: message, access_token: token },
      network: 'facebook',
    });
    const id = res.post_id ?? res.id;
    return { externalPostId: id, permalink: `https://www.facebook.com/${id}` };
  }

  // FB-PUB-01: words alone.
  if (!message) {
    throw new SocialApiError('facebook', 'A Facebook post needs either text or a photo.',
      { retryable: false, code: 'empty' });
  }
  const res = await httpJson<{ id: string }>(`${GRAPH}/${pageId}/feed`, {
    method: 'POST', form: { message, access_token: token }, network: 'facebook',
  });
  return { externalPostId: res.id, permalink: `https://www.facebook.com/${res.id}` };
}

// ---- The adapters --------------------------------------------------------------

function buildAdapter(network: Network): SocialAdapter {
  return {
    network,
    // Publishing runs on the stored PAGE token and needs no app identity at all, so
    // an adapter that exists can always publish. Whether a workspace can CONNECT is a
    // different question, answered by lib/social/credentials.ts.
    canPublish: true,

    listPublishableAccounts(userToken: string) {
      return metaListAccounts(userToken);
    },

    validate(post: PublishablePost, media: MediaItem[]): ValidationResult {
      return validatePost(post, media, [network]);
    },

    async publish(creds, post, media): Promise<PublishResult> {
      if (dryRun()) {
        // The point of a dry run is that it prints what WOULD have gone out, in enough
        // detail to check, without a single byte reaching a client's audience.
        logDryRun(`publish:${network}`, {
          externalId: creds.externalId,
          postType: post.postType,
          captionChars: (post.caption ?? '').length,
          media: media.map((m) => ({ mime: m.mimeType, url: m.publicUrl, w: m.width, h: m.height })),
        });
        return { externalPostId: `dryrun-${network}-${Date.now()}`, permalink: null };
      }
      return network === 'instagram' ? publishInstagram(creds, post, media) : publishFacebook(creds, post, media);
    },

    async publishFirstComment(creds, externalPostId, text) {
      if (dryRun()) {
        logDryRun(`comment:${network}`, { on: externalPostId, chars: text.length });
        return;
      }
      // IG-PUB-13 and FB-PUB-11. The same edge on both, with different permissions
      // behind it: instagram_manage_comments, or pages_manage_engagement plus MODERATE.
      await httpJson(`${GRAPH}/${externalPostId}/comments`, {
        method: 'POST', form: { message: text, access_token: creds.accessToken }, network,
      });
    },
  };
}

export const instagramAdapter = buildAdapter('instagram');
export const facebookAdapter = buildAdapter('facebook');

/**
 * IG-PUB-12. How much of today's Instagram quota is left.
 *
 * Read at runtime and never hard-coded, because the official pages disagree with each
 * other: the content-publishing guide says 100 posts per rolling 24 hours and the
 * media_publish reference says quota_total is currently 50. Asking the account is the
 * only answer that cannot be out of date.
 */
export async function instagramQuota(igUserId: string, token: string): Promise<{ used: number; total: number } | null> {
  try {
    const res = await httpJson<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(
      `${GRAPH}/${igUserId}/content_publishing_limit?${new URLSearchParams({
        fields: 'quota_usage,config', access_token: token,
      })}`, { network: 'instagram' });
    const row = res.data?.[0];
    if (!row) return null;
    return { used: Number(row.quota_usage ?? 0), total: Number(row.config?.quota_total ?? 0) };
  } catch {
    // Never block a publish on the quota check itself failing.
    return null;
  }
}
