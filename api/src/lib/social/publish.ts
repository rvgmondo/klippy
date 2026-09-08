import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/client.js';
import {
  socialPosts, socialPostTargets, socialPostMedia, socialPublishLog,
  storageNodes, businesses, users, accounts,
} from '../../db/schema.js';
import { tenantWhere, withTenant } from '../tenant.js';
import { notify } from '../push.js';
import { sendMail, appUrl, emailBrandFor } from '../mailer.js';
import { renderEmail, renderEmailText } from '../emailLayout.js';
import { publicMediaUrl } from './mediaUrl.js';
import { NETWORK_LABEL, type Network } from './types.js';

/**
 * The minute a post is due.
 *
 * This runs once a minute from a cron endpoint, does a bounded batch, and returns.
 * There is no worker and no queue, because the host has neither, and a job that must
 * finish inside one HTTP request is a job that cannot quietly wedge.
 *
 * THE THING THAT MUST NEVER HAPPEN IS PUBLISHING TWICE. A duplicate post to a
 * client's audience cannot be recalled, and "the cron ran twice" is not an
 * explanation anyone accepts. So work is CLAIMED with a conditional UPDATE before it
 * is touched: the row moves to `publishing` and takes this run's random `lock_token`
 * in the same statement that checks it was still `scheduled`. Two overlapping runs
 * cannot both win that update, whatever the database is doing underneath, and the
 * batch is read back BY THAT TOKEN rather than by the timestamp, because a DATETIME
 * has no fractional seconds and two runs in the same second would otherwise each pick
 * up the other's rows. A claim older than ten minutes is treated as a crashed run and
 * reclaimed, so a process killed mid-batch does not strand a post forever.
 *
 * In this phase only MANUAL delivery is carried out: the network adapters land in the
 * next phases. A manual post at its scheduled minute sends the caption and the media
 * links to whoever owns it and moves to `needs_manual`, where it waits to be told it
 * went out. That is the whole Metricool replacement, and it works on every network
 * with no platform approval at all.
 */

/** How many posts one run will take. Small on purpose: this is inside a web request. */
const BATCH = 5;
/** A claim older than this is assumed to be from a run that died. */
const STALE_LOCK_MINUTES = 10;

export interface PublishRunResult {
  ok: boolean;
  claimed: number;
  published: number;
  failed: number;
  manual: number;
  message: string;
}

export async function runSocialPublish(): Promise<PublishRunResult> {
  const now = new Date();
  const stale = new Date(now.getTime() - STALE_LOCK_MINUTES * 60_000);
  // This run's identity. Read the batch back by THIS, never by the timestamp: a
  // DATETIME has no fractional seconds, so two runs in the same second would stamp
  // the same lockedAt and each would pick up the other's rows and post them twice.
  const token = randomBytes(16).toString('hex');

  /**
   * Claim the work.
   *
   * One statement, and the WHERE is what makes it safe: only rows still `scheduled`
   * and due, and only ones not already claimed by a live run. Whoever the database
   * lets through is the only runner that sees them.
   */
  const claim = await db.update(socialPosts).set({
    status: 'publishing',
    lockedAt: now,
    lockToken: token,
    attempts: sql`${socialPosts.attempts} + 1`,
  }).where(and(
    eq(socialPosts.status, 'scheduled'),
    lte(socialPosts.scheduledAt, now),
    or(isNull(socialPosts.lockedAt), lte(socialPosts.lockedAt, stale)),
  )).limit(BATCH);

  const claimed = Number(claim[0]?.affectedRows ?? 0);
  if (!claimed) {
    return { ok: true, claimed: 0, published: 0, failed: 0, manual: 0, message: 'Nothing due.' };
  }

  // Read back exactly what this run claimed, by its own token.
  const posts = await db.select().from(socialPosts)
    .where(and(eq(socialPosts.status, 'publishing'), eq(socialPosts.lockToken, token)))
    .limit(BATCH);

  let manual = 0;
  let published = 0;
  let failed = 0;

  for (const post of posts) {
    try {
      if (post.deliveryMode === 'manual') {
        await sendManualPrompt(post);
        manual++;
        continue;
      }
      /**
       * Automatic delivery, with no adapter written yet.
       *
       * It falls back to the manual path rather than failing. A post whose network
       * cannot be published to automatically is not a broken post: it is a post
       * somebody needs to put up, and telling them is strictly better than a red
       * error on a calendar at nine in the morning. When the adapters land this
       * branch narrows to only the networks that genuinely cannot autopublish.
       */
      await sendManualPrompt(post, { becauseNoAdapter: true });
      manual++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : 'Unknown error';
      await db.update(socialPosts).set({ status: 'failed', lockedAt: null, lockToken: null })
        .where(tenantWhere(socialPosts, post.accountId, eq(socialPosts.id, post.id)));
      await log(post.accountId, post.id, null, 'error', `Could not hand this over: ${message}`);
    }
  }

  return {
    ok: true, claimed, published, failed, manual,
    message: `${claimed} claimed, ${manual} sent to be posted by hand, ${published} published, ${failed} failed.`,
  };
}

/**
 * Tell somebody it is time to post this, and give them everything they need.
 *
 * The push is the nudge and the email is the payload: the caption ready to copy, the
 * first comment, and a direct link to every file. A prompt that says only "time to
 * post" makes a person open a laptop, find the post, copy the words and download the
 * pictures. This one is meant to be actionable from a phone in under a minute, which
 * is the entire promise of manual delivery.
 */
async function sendManualPrompt(
  post: typeof socialPosts.$inferSelect,
  opts: { becauseNoAdapter?: boolean } = {},
): Promise<void> {
  const targets = await db.select({
    id: socialPostTargets.id, network: socialPostTargets.network,
    captionOverride: socialPostTargets.captionOverride,
  }).from(socialPostTargets)
    .where(tenantWhere(socialPostTargets, post.accountId,
      eq(socialPostTargets.postId, post.id),
      inArray(socialPostTargets.status, ['pending', 'failed'])));

  const media = await db.select({
    token: socialPostMedia.publicToken, mimeType: socialPostMedia.mimeType,
    name: storageNodes.name, position: socialPostMedia.position,
  }).from(socialPostMedia)
    .innerJoin(storageNodes, eq(storageNodes.id, socialPostMedia.storageNodeId))
    .where(tenantWhere(socialPostMedia, post.accountId, eq(socialPostMedia.postId, post.id)))
    .orderBy(socialPostMedia.position);

  const [biz] = await db.select({ name: businesses.name }).from(businesses)
    .where(tenantWhere(businesses, post.accountId, eq(businesses.id, post.businessId))).limit(1);

  const networks = targets.map((t) => NETWORK_LABEL[t.network as Network]).join(', ') || 'your channels';
  const link = `${appUrl()}/?v=social&post=${post.id}`;

  // Push first: it is the part that actually reaches a phone at 09:00.
  if (post.createdBy) {
    notify(post.createdBy, {
      title: `Time to post: ${post.title}`,
      body: (post.caption ?? '').split('\n')[0]?.slice(0, 140) || `Ready for ${networks}.`,
      url: link,
      // Tagged per post so a second nudge replaces the first rather than stacking.
      tag: `social-post-${post.id}`,
    });
  }

  const owner = post.createdBy
    ? (await db.select({ email: users.email, name: users.name }).from(users)
        .where(eq(users.id, post.createdBy)).limit(1))[0]
    : undefined;

  if (owner?.email) {
    const caption = post.caption ?? '';
    const lines: string[] = [
      opts.becauseNoAdapter
        ? `This is due now on ${networks}. Klippy cannot post to it automatically yet, so it needs you.`
        : `This is due now on ${networks}, and it is set to be posted by hand.`,
      '',
      'CAPTION, ready to copy:',
      caption || '(no caption)',
    ];
    if (post.firstComment) lines.push('', 'FIRST COMMENT:', post.firstComment);
    if (media.length) {
      lines.push('', 'FILES:');
      for (const m of media) {
        const url = publicMediaUrl(m.token, m.mimeType);
        lines.push(`- ${m.name}${url ? `: ${url}` : ''}`);
      }
    }
    lines.push('', 'When it is up, open Klippy and mark it as posted so the calendar stays right.');

    const content = {
      heading: `Time to post: ${post.title}`,
      body: lines,
      cta: { label: 'Open it in Klippy', url: link },
      footer: biz?.name ? `For ${biz.name}.` : undefined,
    };
    const brand = await emailBrandFor(post.accountId, post.businessId);
    await sendMail(
      owner.email,
      `Time to post: ${post.title}`,
      renderEmailText(brand, content),
      renderEmail(brand, content),
    ).catch(() => { /* the post still shows as needing action in the app */ });
  }

  await db.update(socialPosts).set({ status: 'needs_manual', lockedAt: null, lockToken: null })
    .where(tenantWhere(socialPosts, post.accountId, eq(socialPosts.id, post.id)));

  await log(post.accountId, post.id, null, 'info',
    opts.becauseNoAdapter
      ? `Sent to be posted by hand on ${networks}, because Klippy cannot publish to it automatically yet.`
      : `Sent to be posted by hand on ${networks}.`);
}

async function log(
  accountId: number, postId: number, targetId: number | null,
  level: 'info' | 'warn' | 'error', message: string, payload?: unknown,
): Promise<void> {
  await db.insert(socialPublishLog).values(withTenant(accountId, {
    postId, targetId, level, message: message.slice(0, 1000),
    payload: payload === undefined ? null : payload,
  } as never)).catch(() => { /* a log write must never break a publish run */ });
}
