import type { MediaItem, Network, PublishablePost, ValidationIssue, ValidationResult } from './types.js';

/**
 * What each network will refuse, checked before anything is scheduled.
 *
 * Every rule here cites its row in docs/social/API-NOTES.md. That citation is not
 * decoration: these limits change (Instagram dropped non-Reel video in 2023, both
 * Meta surfaces dropped impressions in 2025), and a rule with no source is a rule
 * nobody can safely update.
 *
 * The point is to fail in the composer, where a person can fix it in ten seconds,
 * rather than at 09:00 on a Monday inside a cron job, where all anyone sees is that
 * the client's post did not go out.
 *
 * ERRORS BLOCK SCHEDULING, WARNINGS DO NOT. A caption that is long for LinkedIn but
 * fine for Instagram is a warning on LinkedIn only. Refusing to schedule the whole
 * post over it would be wrong, because the other two networks would have taken it.
 */

// ---- Instagram (X-LIM-01, X-LIM-02, X-LIM-06, X-LIM-07, X-LIM-08) ----------------
const IG_CAPTION_MAX = 2200;
const IG_HASHTAG_MAX = 30;
const IG_MENTION_MAX = 20;
const IG_IMAGE_BYTES_MAX = 8 * 1024 * 1024;
const IG_IMAGE_MIN_WIDTH = 320;
const IG_IMAGE_MAX_WIDTH = 1440;
const IG_ASPECT_MIN = 4 / 5;      // 0.8, tallest allowed
const IG_ASPECT_MAX = 1.91;       // widest allowed
const IG_CAROUSEL_MIN = 2;
const IG_CAROUSEL_MAX = 10;

// ---- LinkedIn (X-LIM-03) ---------------------------------------------------------
const LI_COMMENTARY_MAX = 3000;

// ---- Facebook (X-LIM-10, X-LIM-11) -----------------------------------------------
const FB_PHOTO_BYTES_MAX = 10 * 1024 * 1024;
const FB_VIDEO_BYTES_MAX = 1024 * 1024 * 1024;

const isImage = (m: MediaItem) => (m.mimeType ?? '').startsWith('image/');
const isVideo = (m: MediaItem) => (m.mimeType ?? '').startsWith('video/');
const isJpeg = (m: MediaItem) => /^image\/jpe?g$/i.test(m.mimeType ?? '');

/** Hashtags and mentions, counted the way a platform counts them. */
export function countTags(text: string): { hashtags: number; mentions: number } {
  return {
    hashtags: (text.match(/(?:^|\s)#[\wÀ-ɏ]+/g) ?? []).length,
    mentions: (text.match(/(?:^|\s)@[\w.]+/g) ?? []).length,
  };
}

function captionFor(post: PublishablePost, override?: string | null): string {
  return (override ?? post.caption ?? '').trim();
}

function instagram(post: PublishablePost, media: MediaItem[], caption: string): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const err = (field: ValidationIssue['field'], message: string, rule: string) =>
    out.push({ network: 'instagram', field, message, rule, severity: 'error' });

  // Instagram is the only one of the three that cannot post words alone.
  if (!media.length) {
    err('media', 'Instagram needs at least one photo or video.', 'IG-PUB-01');
  }

  if (caption.length > IG_CAPTION_MAX) {
    err('caption', `Instagram allows ${IG_CAPTION_MAX} characters and this is ${caption.length}. Hashtags count too.`, 'X-LIM-01');
  }
  const { hashtags, mentions } = countTags(caption);
  if (hashtags > IG_HASHTAG_MAX) err('caption', `Instagram allows ${IG_HASHTAG_MAX} hashtags and this has ${hashtags}.`, 'X-LIM-01');
  if (mentions > IG_MENTION_MAX) err('caption', `Instagram allows ${IG_MENTION_MAX} @ mentions and this has ${mentions}.`, 'X-LIM-01');

  if (post.postType === 'carousel') {
    if (media.length < IG_CAROUSEL_MIN || media.length > IG_CAROUSEL_MAX) {
      err('media', `An Instagram carousel needs between ${IG_CAROUSEL_MIN} and ${IG_CAROUSEL_MAX} items and this has ${media.length}.`, 'X-LIM-06');
    }
  } else if (media.length > 1) {
    out.push({
      network: 'instagram', field: 'media', severity: 'warning', rule: 'X-LIM-06',
      message: 'Instagram will only use the first file unless this is set to a carousel.',
    });
  }

  for (const m of media) {
    const where = `File ${m.position + 1}`;
    if (isImage(m)) {
      // The single most common rejection, and the reason images are transcoded.
      if (!isJpeg(m)) err('media', `${where} must be a JPEG for Instagram. Klippy converts it when it can.`, 'X-LIM-07');
      if (m.bytes != null && m.bytes > IG_IMAGE_BYTES_MAX) err('media', `${where} is over 8 MB, which Instagram refuses.`, 'X-LIM-07');
      if (m.width != null) {
        if (m.width < IG_IMAGE_MIN_WIDTH) err('media', `${where} is ${m.width} px wide. Instagram needs at least ${IG_IMAGE_MIN_WIDTH}.`, 'X-LIM-07');
        if (m.width > IG_IMAGE_MAX_WIDTH) {
          out.push({
            network: 'instagram', field: 'media', severity: 'warning', rule: 'X-LIM-07',
            message: `${where} is wider than ${IG_IMAGE_MAX_WIDTH} px, so Instagram will scale it down.`,
          });
        }
      }
      if (m.width && m.height) {
        const ratio = m.width / m.height;
        if (ratio < IG_ASPECT_MIN || ratio > IG_ASPECT_MAX) {
          err('media', `${where} is ${ratio.toFixed(2)}:1. Instagram accepts 0.80 (tall) to 1.91 (wide).`, 'X-LIM-07');
        }
      }
    } else if (isVideo(m)) {
      // Since November 2023 every single Instagram video post is a Reel, whatever it
      // is called in the composer. Saying so here beats a container error at 09:00.
      if (post.postType !== 'reel' && post.postType !== 'carousel' && post.postType !== 'story') {
        out.push({
          network: 'instagram', field: 'postType', severity: 'warning', rule: 'IG-PUB-03',
          message: 'Instagram publishes every video as a Reel. This will go out as a Reel.',
        });
      }
    } else {
      err('media', `${where} is not a photo or a video, so Instagram cannot take it.`, 'X-LIM-07');
    }
  }
  return out;
}

function facebook(post: PublishablePost, media: MediaItem[], caption: string): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const err = (field: ValidationIssue['field'], message: string, rule: string) =>
    out.push({ network: 'facebook', field, message, rule, severity: 'error' });

  // A Facebook Page post needs words or a file; empty is the one thing it refuses.
  if (!caption && !media.length) {
    err('caption', 'A Facebook post needs either text or a photo.', 'FB-PUB-01');
  }
  for (const m of media) {
    const where = `File ${m.position + 1}`;
    if (isImage(m) && m.bytes != null && m.bytes > FB_PHOTO_BYTES_MAX) {
      err('media', `${where} is over 10 MB, which Facebook refuses for photos.`, 'X-LIM-10');
    }
    if (isVideo(m) && m.bytes != null && m.bytes > FB_VIDEO_BYTES_MAX) {
      err('media', `${where} is over 1 GB, the limit for a video sent by URL.`, 'X-LIM-11');
    }
  }
  return out;
}

function linkedin(post: PublishablePost, media: MediaItem[], caption: string): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const err = (field: ValidationIssue['field'], message: string, rule: string) =>
    out.push({ network: 'linkedin', field, message, rule, severity: 'error' });

  if (!caption && !media.length) {
    err('caption', 'A LinkedIn post needs either text or an image.', 'LI-POST-02');
  }
  if (caption.length > LI_COMMENTARY_MAX) {
    err('caption', `LinkedIn allows ${LI_COMMENTARY_MAX} characters and this is ${caption.length}.`, 'X-LIM-03');
  }
  // Organic carousels do not exist on LinkedIn; several images become a multi-image
  // post instead, which is a different thing and worth saying before it surprises.
  if (post.postType === 'carousel' && media.length > 1) {
    out.push({
      network: 'linkedin', field: 'postType', severity: 'warning', rule: 'LI-POST-05',
      message: 'LinkedIn has no organic carousel. This goes out as a multi-image post.',
    });
  }
  if (post.postType === 'story') {
    err('postType', 'LinkedIn has no stories. Untick LinkedIn or change the post type.', 'LI-POST-01');
  }
  return out;
}

/**
 * Check one post against every network it is going to.
 *
 * `overrides` carries the per-network caption when there is one, because a caption
 * that is only used on LinkedIn must be the caption LinkedIn is measured against.
 */
export function validatePost(
  post: PublishablePost,
  media: MediaItem[],
  networks: Network[],
  overrides: Partial<Record<Network, string | null>> = {},
): ValidationResult {
  const sorted = [...media].sort((a, b) => a.position - b.position);
  const issues: ValidationIssue[] = [];

  for (const n of networks) {
    const caption = captionFor(post, overrides[n]);
    if (n === 'instagram') issues.push(...instagram(post, sorted, caption));
    if (n === 'facebook') issues.push(...facebook(post, sorted, caption));
    if (n === 'linkedin') issues.push(...linkedin(post, sorted, caption));
  }

  if (!networks.length) {
    issues.push({
      network: 'instagram', field: 'account', severity: 'error',
      message: 'Pick at least one account to post to.',
    });
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}
