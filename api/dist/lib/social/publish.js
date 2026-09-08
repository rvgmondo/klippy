import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/client.js';
import { socialPosts, socialPostTargets, socialPostMedia, socialPublishLog, socialAccounts, storageNodes, businesses, users, } from '../../db/schema.js';
import { tenantWhere, withTenant } from '../tenant.js';
import { notify } from '../push.js';
import { sendMail, appUrl, emailBrandFor } from '../mailer.js';
import { renderEmail, renderEmailText } from '../emailLayout.js';
import { publicMediaUrl } from './mediaUrl.js';
import { decryptToken } from './tokens.js';
import { adapterFor, whyNotAutomatic } from './registry.js';
import { NETWORK_LABEL, SocialApiError, } from './types.js';
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
 * Two delivery paths, and MANUAL IS NOT THE LESSER ONE. A manual post sends the
 * caption and the media links to whoever owns it and waits to be told it went out.
 * Every automatic post falls back to exactly that whenever a network has no adapter,
 * no connected account, or no app credentials on this server, which is the normal
 * state while a platform approval is pending. That fallback is what lets the whole
 * calendar work on every network from the first day.
 */
/** How many posts one run will take. Small on purpose: this is inside a web request. */
const BATCH = 5;
/** A claim older than this is assumed to be from a run that died. */
const STALE_LOCK_MINUTES = 10;
/** Three tries: enough to ride out a rate limit, few enough to notice today. */
const MAX_ATTEMPTS = 3;
export async function runSocialPublish() {
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
        attempts: sql `${socialPosts.attempts} + 1`,
    }).where(and(eq(socialPosts.status, 'scheduled'), lte(socialPosts.scheduledAt, now), or(isNull(socialPosts.lockedAt), lte(socialPosts.lockedAt, stale)))).limit(BATCH);
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
            const outcome = await publishAutomatically(post);
            if (outcome === 'published')
                published++;
            else if (outcome === 'manual')
                manual++;
            else
                failed++;
        }
        catch (err) {
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
 * Publish a post to every network that can take it automatically.
 *
 * Each target succeeds or fails ON ITS OWN, which is the entire reason targets are
 * separate rows. Instagram going out and LinkedIn failing is a real and common state,
 * and a single status would have to lie about one of them.
 *
 * WHAT IS RETRIED, AND WHAT IS NOT. The adapter decides, because it is the only thing
 * that knows what the platform said: a rate limit is worth another go, an expired
 * token is not and needs a person. Retrying a permanent failure burns quota and looks
 * broken; giving up on a transient one silently drops a client's post.
 *
 * A target with no connected account, or on a network with no adapter, is NOT a
 * failure. It is handed to a person, which is the same path a manual post takes.
 */
async function publishAutomatically(post) {
    const targets = await db.select().from(socialPostTargets)
        .where(tenantWhere(socialPostTargets, post.accountId, eq(socialPostTargets.postId, post.id), inArray(socialPostTargets.status, ['pending', 'failed'])));
    if (!targets.length) {
        await db.update(socialPosts).set({ status: 'published', lockedAt: null, lockToken: null })
            .where(tenantWhere(socialPosts, post.accountId, eq(socialPosts.id, post.id)));
        return 'published';
    }
    const media = await mediaFor(post);
    const publishable = {
        id: post.id, title: post.title, caption: post.caption ?? '',
        firstComment: post.firstComment, postType: post.postType,
    };
    let anyPublished = false;
    let anyFailed = false;
    let anyManual = false;
    for (const target of targets) {
        const network = target.network;
        const adapter = adapterFor(network);
        const account = target.socialAccountId
            ? (await db.select().from(socialAccounts)
                .where(tenantWhere(socialAccounts, post.accountId, eq(socialAccounts.id, target.socialAccountId))).limit(1))[0]
            : undefined;
        // Nothing to publish through: this one needs a person, and that is a normal
        // outcome rather than an error.
        if (!adapter || !adapter.canPublish || !account || account.status !== 'connected' || !account.accessTokenEnc) {
            anyManual = true;
            await log(post.accountId, post.id, target.id, 'info', whyNotAutomatic(network));
            continue;
        }
        try {
            await db.update(socialPostTargets).set({ status: 'publishing' })
                .where(tenantWhere(socialPostTargets, post.accountId, eq(socialPostTargets.id, target.id)));
            const creds = {
                accessToken: decryptToken(account.accessTokenEnc),
                refreshToken: account.refreshTokenEnc ? decryptToken(account.refreshTokenEnc) : null,
                externalId: account.externalId,
            };
            const caption = target.captionOverride ?? publishable.caption;
            const result = await adapter.publish(creds, { ...publishable, caption }, media);
            // The first comment must never fail the post: the post is already out, and
            // reporting it as failed would invite somebody to publish it a second time.
            if (post.firstComment && adapter.publishFirstComment) {
                try {
                    await adapter.publishFirstComment(creds, result.externalPostId, post.firstComment);
                }
                catch (err) {
                    await log(post.accountId, post.id, target.id, 'warn', `Posted, but the first comment did not go up: ${err instanceof Error ? err.message : 'unknown error'}`);
                }
            }
            await db.update(socialPostTargets).set({
                status: 'published', externalPostId: result.externalPostId,
                permalink: result.permalink, publishedAt: new Date(), error: null, nextAttemptAt: null,
            }).where(tenantWhere(socialPostTargets, post.accountId, eq(socialPostTargets.id, target.id)));
            await log(post.accountId, post.id, target.id, 'info', `Published to ${NETWORK_LABEL[network]}.`);
            anyPublished = true;
        }
        catch (err) {
            anyFailed = true;
            const retryable = err instanceof SocialApiError ? err.retryable : true;
            const message = err instanceof Error ? err.message : 'Unknown error';
            const attempts = (target.attempts ?? 0) + 1;
            // BACKOFF: 2, 10, then 30 minutes, then it stops asking. Three tries is enough
            // to ride out a rate limit and few enough that a broken post is noticed today.
            const waitMinutes = [2, 10, 30][attempts - 1];
            const giveUp = !retryable || attempts >= MAX_ATTEMPTS || waitMinutes === undefined;
            await db.update(socialPostTargets).set({
                status: 'failed', attempts, error: message.slice(0, 500),
                nextAttemptAt: giveUp ? null : new Date(Date.now() + waitMinutes * 60_000),
            }).where(tenantWhere(socialPostTargets, post.accountId, eq(socialPostTargets.id, target.id)));
            await log(post.accountId, post.id, target.id, 'error', giveUp
                ? `${NETWORK_LABEL[network]} refused it: ${message}`
                : `${NETWORK_LABEL[network]} failed, trying again in ${waitMinutes} minutes: ${message}`, err instanceof SocialApiError ? err.detail : undefined);
        }
    }
    // The post's own status is the honest summary of its targets, which is why
    // partially_published exists at all.
    const status = anyFailed && anyPublished ? 'partially_published'
        : anyFailed ? 'failed'
            : anyManual && !anyPublished ? 'needs_manual'
                : anyManual ? 'partially_published'
                    : 'published';
    await db.update(socialPosts).set({ status, lockedAt: null, lockToken: null })
        .where(tenantWhere(socialPosts, post.accountId, eq(socialPosts.id, post.id)));
    if (anyManual)
        await sendManualPrompt(post, { becauseNoAdapter: true, keepStatus: true });
    if (anyFailed)
        await tellSomebodyItFailed(post);
    return anyPublished ? 'published' : anyManual ? 'manual' : 'failed';
}
/** The media of one post, in the shape an adapter takes. */
async function mediaFor(post) {
    const rows = await db.select({
        id: socialPostMedia.id, position: socialPostMedia.position,
        mimeType: socialPostMedia.mimeType, width: socialPostMedia.width,
        height: socialPostMedia.height, durationMs: socialPostMedia.durationMs,
        altText: socialPostMedia.altText, publicToken: socialPostMedia.publicToken,
        bytes: storageNodes.size, nodeMime: storageNodes.mimeType, storageKey: storageNodes.storageKey,
    }).from(socialPostMedia)
        .innerJoin(storageNodes, eq(storageNodes.id, socialPostMedia.storageNodeId))
        .where(tenantWhere(socialPostMedia, post.accountId, eq(socialPostMedia.postId, post.id)))
        .orderBy(socialPostMedia.position);
    return rows.map((r) => ({
        id: r.id, position: r.position, mimeType: r.mimeType ?? r.nodeMime,
        width: r.width, height: r.height, durationMs: r.durationMs,
        bytes: r.bytes, altText: r.altText,
        publicUrl: publicMediaUrl(r.publicToken, r.mimeType ?? r.nodeMime),
        storageKey: r.storageKey,
    }));
}
/**
 * A post did not go out. Say so to the person who wrote it, with a way to fix it.
 *
 * The email carries the platform's own words rather than a tidied summary, because
 * "Instagram refused it" tells nobody anything, and the reason is usually specific and
 * actionable: an expired connection, an image too tall, a caption too long.
 */
async function tellSomebodyItFailed(post) {
    if (!post.createdBy)
        return;
    const failures = await db.select({
        network: socialPostTargets.network, error: socialPostTargets.error,
    }).from(socialPostTargets)
        .where(tenantWhere(socialPostTargets, post.accountId, eq(socialPostTargets.postId, post.id), eq(socialPostTargets.status, 'failed')));
    if (!failures.length)
        return;
    const link = `${appUrl()}/?v=social&post=${post.id}`;
    notify(post.createdBy, {
        title: `Did not go out: ${post.title}`,
        body: failures[0]?.error?.slice(0, 140) ?? 'Open Klippy to see why.',
        url: link,
        tag: `social-failed-${post.id}`,
    });
    const [owner] = await db.select({ email: users.email }).from(users)
        .where(eq(users.id, post.createdBy)).limit(1);
    if (!owner?.email)
        return;
    const content = {
        heading: `This post did not go out: ${post.title}`,
        body: [
            'Klippy tried and could not publish it. What each network said:',
            '',
            ...failures.map((f) => `${NETWORK_LABEL[f.network]}: ${f.error ?? 'no reason given'}`),
            '',
            'You can fix it and reschedule, or post it by hand and mark it as posted.',
        ],
        cta: { label: 'Open the post', url: link },
    };
    const brand = await emailBrandFor(post.accountId, post.businessId);
    await sendMail(owner.email, `Did not go out: ${post.title}`, renderEmailText(brand, content), renderEmail(brand, content))
        .catch(() => { });
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
async function sendManualPrompt(post, opts = {}) {
    const targets = await db.select({
        id: socialPostTargets.id, network: socialPostTargets.network,
        captionOverride: socialPostTargets.captionOverride,
    }).from(socialPostTargets)
        .where(tenantWhere(socialPostTargets, post.accountId, eq(socialPostTargets.postId, post.id), inArray(socialPostTargets.status, ['pending', 'failed'])));
    const media = await db.select({
        token: socialPostMedia.publicToken, mimeType: socialPostMedia.mimeType,
        name: storageNodes.name, position: socialPostMedia.position,
    }).from(socialPostMedia)
        .innerJoin(storageNodes, eq(storageNodes.id, socialPostMedia.storageNodeId))
        .where(tenantWhere(socialPostMedia, post.accountId, eq(socialPostMedia.postId, post.id)))
        .orderBy(socialPostMedia.position);
    const [biz] = await db.select({ name: businesses.name }).from(businesses)
        .where(tenantWhere(businesses, post.accountId, eq(businesses.id, post.businessId))).limit(1);
    const networks = targets.map((t) => NETWORK_LABEL[t.network]).join(', ') || 'your channels';
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
        const lines = [
            opts.becauseNoAdapter
                ? `This is due now on ${networks}. Klippy cannot post to it automatically yet, so it needs you.`
                : `This is due now on ${networks}, and it is set to be posted by hand.`,
            '',
            'CAPTION, ready to copy:',
            caption || '(no caption)',
        ];
        if (post.firstComment)
            lines.push('', 'FIRST COMMENT:', post.firstComment);
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
        await sendMail(owner.email, `Time to post: ${post.title}`, renderEmailText(brand, content), renderEmail(brand, content)).catch(() => { });
    }
    // When the caller has already worked out the post's real status (some networks
    // published, some need a person), do not flatten it back to needs_manual.
    if (!opts.keepStatus) {
        await db.update(socialPosts).set({ status: 'needs_manual', lockedAt: null, lockToken: null })
            .where(tenantWhere(socialPosts, post.accountId, eq(socialPosts.id, post.id)));
    }
    await log(post.accountId, post.id, null, 'info', opts.becauseNoAdapter
        ? `Sent to be posted by hand on ${networks}, because Klippy cannot publish to it automatically yet.`
        : `Sent to be posted by hand on ${networks}.`);
}
async function log(accountId, postId, targetId, level, message, payload) {
    await db.insert(socialPublishLog).values(withTenant(accountId, {
        postId, targetId, level, message: message.slice(0, 1000),
        payload: payload === undefined ? null : payload,
    })).catch(() => { });
}
//# sourceMappingURL=publish.js.map