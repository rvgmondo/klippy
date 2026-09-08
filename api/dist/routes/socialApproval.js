import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { socialPosts, socialPostTargets, socialPostMedia, socialPublishLog, businesses, accounts, } from '../db/schema.js';
import { withTenant } from '../lib/tenant.js';
import { publicMediaUrl } from '../lib/social/mediaUrl.js';
import { signLogoToken } from '../lib/secretbox.js';
import { notifyUsers } from '../lib/notify.js';
import { appUrl } from '../lib/mailer.js';
/**
 * The client approval page, which is the only part of Klippy Social a client ever
 * touches.
 *
 * It is public and unauthenticated for the same reason the media route is: the person
 * signing off a coffee shop's Instagram post does not have a Klippy login, will never
 * be given one, and is reading this on a phone between two other things. A sign-in
 * wall here is a post that never gets approved.
 *
 * So the same rules as routes/socialMedia.ts apply, and for the same reasons:
 *
 *   - THE TOKEN IS THE CREDENTIAL. 32 random bytes, unique across the table, and
 *     revoked by nulling one column. There is no id to enumerate and no listing.
 *   - IT SERVES ONE POST. Everything returned is reached FROM the row the token
 *     found, never from anything the caller sent. A token cannot be pointed at
 *     another post, another business, or another workspace.
 *   - IT IS NOT A TENANT ROUTE, which is why there is no tenantWhere on the lookup:
 *     there is no session to scope to, and the token IS the scope. Every write below
 *     still carries the accountId that came off the post, so nothing this route
 *     writes can land in a different workspace.
 *
 * What it deliberately does NOT expose: the internal title, who wrote it, the media
 * ask, the publish log, the connected accounts, anything about any other post. A
 * client sees the words, the pictures, when it goes out and where. That is the job.
 */
/** Cheap shape check before touching the database, so a scan of nonsense costs nothing. */
const TOKEN_RE = /^[a-f0-9]{32,64}$/i;
/**
 * What the client is looking at.
 *
 * Read off the post's own status rather than stored separately, because two places
 * recording the same fact is two places to disagree: a post scheduled by the agency
 * after sign-off must not still say "waiting for your approval".
 */
function outcomeOf(status, approvedAt) {
    if (status === 'awaiting_approval')
        return 'awaiting';
    /**
     * Dead first, and this ORDER is the fix.
     *
     * Cancelling a post leaves approvedAt where it was, so a rule that reads the stamp
     * before the status tells a client their cancelled post is approved and still going
     * out on Friday. A client who cancelled a campaign by phone on Tuesday and reopens
     * the link on Wednesday is exactly the person who would believe it.
     */
    if (status === 'cancelled' || status === 'failed')
        return 'closed';
    if (['approved', 'scheduled', 'publishing', 'published', 'partially_published', 'needs_manual'].includes(status)) {
        return 'approved';
    }
    // A post back in draft holding a live token is one the client sent back. Nothing
    // else can be in that state: a staff edit withdraws the token with the approval.
    if (status === 'draft' || status === 'needs_media')
        return 'changes';
    if (approvedAt)
        return 'approved';
    return 'closed';
}
/** The scheduled time as words, in the workspace's zone rather than the reader's. */
function whenLabel(at, timeZone) {
    if (!at)
        return null;
    try {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone, weekday: 'long', day: 'numeric', month: 'long',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(at);
    }
    catch {
        return at.toISOString().slice(0, 16).replace('T', ' ');
    }
}
export async function socialApprovalRoutes(app) {
    /** Everything the page needs, in one request, so a phone on a bad line renders once. */
    app.get('/api/v1/approve/:token', async (req, reply) => {
        const token = req.params.token ?? '';
        if (!TOKEN_RE.test(token))
            return reply.code(404).send({ error: 'This link is not valid.' });
        const [post] = await db.select().from(socialPosts)
            .where(eq(socialPosts.approvalToken, token)).limit(1);
        // The same answer for a token that never existed and one that was withdrawn.
        // Telling them apart tells a stranger which guesses were close.
        if (!post)
            return reply.code(404).send({ error: 'This link is not valid.' });
        const [biz] = await db.select({
            id: businesses.id, name: businesses.name,
            brandName: businesses.brandName, logoPath: businesses.logoPath, color: businesses.color,
        }).from(businesses).where(eq(businesses.id, post.businessId)).limit(1);
        const [acct] = await db.select({ tz: accounts.timezone }).from(accounts)
            .where(eq(accounts.id, post.accountId)).limit(1);
        const timezone = acct?.tz || 'Africa/Johannesburg';
        const [targets, media] = await Promise.all([
            db.select({ network: socialPostTargets.network, captionOverride: socialPostTargets.captionOverride })
                .from(socialPostTargets).where(eq(socialPostTargets.postId, post.id)),
            db.select({
                id: socialPostMedia.id, position: socialPostMedia.position,
                mimeType: socialPostMedia.mimeType, altText: socialPostMedia.altText,
                publicToken: socialPostMedia.publicToken,
            }).from(socialPostMedia).where(eq(socialPostMedia.postId, post.id))
                .orderBy(asc(socialPostMedia.position)),
        ]);
        const logoToken = biz?.logoPath ? signLogoToken('business', biz.id) : null;
        const outcome = outcomeOf(post.status, post.approvedAt);
        // A post that is not going out has no date to promise. "Planned for Friday" beside
        // "nothing to do here" is the page arguing with itself.
        const showSchedule = outcome !== 'closed';
        return {
            brand: {
                name: biz?.brandName || biz?.name || 'Your business',
                color: biz?.color ?? '#6366f1',
                logoUrl: logoToken && biz ? `${appUrl()}/api/v1/public/logo/business/${biz.id}?t=${logoToken}` : null,
            },
            outcome,
            post: {
                caption: post.caption ?? '',
                firstComment: post.firstComment,
                postType: post.postType,
                scheduledAt: showSchedule && post.scheduledAt ? post.scheduledAt.toISOString() : null,
                whenLabel: showSchedule ? whenLabel(post.scheduledAt, timezone) : null,
                // Per network, because a caption override means the client is approving
                // something different on LinkedIn than on Instagram, and showing one of them
                // twice is showing them something they never agreed to.
                networks: targets.map((t) => ({
                    network: t.network,
                    caption: t.captionOverride ?? post.caption ?? '',
                })),
                media: media.map((m) => ({
                    id: m.id, mimeType: m.mimeType, altText: m.altText,
                    url: publicMediaUrl(m.publicToken, m.mimeType),
                })),
            },
            decision: post.approvedAt
                ? { name: post.approvedByName, at: post.approvedAt.toISOString() }
                : null,
        };
    });
    /**
     * The decision itself.
     *
     * Only accepted while the post is actually waiting. Once it has been signed off and
     * scheduled, a second tap on an old link in a mailbox must not unpick it, and once
     * changes have been asked for, the same link must not send a second contradictory
     * answer. Both come back as a plain "this has already been dealt with" rather than
     * an error, because from the client's side that is what it is.
     */
    app.post('/api/v1/approve/:token', async (req, reply) => {
        const token = req.params.token ?? '';
        if (!TOKEN_RE.test(token))
            return reply.code(404).send({ error: 'This link is not valid.' });
        const parsed = z.object({
            decision: z.enum(['approve', 'changes']),
            name: z.string().trim().min(1).max(120),
            comment: z.string().trim().max(2000).optional(),
        }).safeParse(req.body ?? {});
        if (!parsed.success) {
            return reply.code(400).send({ error: 'Add your name, and say approve or changes.' });
        }
        const { decision, name } = parsed.data;
        const comment = parsed.data.comment?.trim() ?? '';
        // Asking for changes without saying what is a message nobody can act on, and the
        // agency finds out only by asking. Better refused here, where it can be fixed.
        if (decision === 'changes' && !comment) {
            return reply.code(400).send({ error: 'Tell them what to change, so they can fix it.' });
        }
        const [post] = await db.select().from(socialPosts)
            .where(eq(socialPosts.approvalToken, token)).limit(1);
        if (!post)
            return reply.code(404).send({ error: 'This link is not valid.' });
        if (post.status !== 'awaiting_approval') {
            return reply.code(409).send({
                error: 'This has already been dealt with.',
                outcome: outcomeOf(post.status, post.approvedAt),
            });
        }
        const accountId = post.accountId;
        if (decision === 'approve') {
            await db.update(socialPosts).set({
                status: 'approved', approvedAt: new Date(), approvedByName: name,
            }).where(and(eq(socialPosts.id, post.id), eq(socialPosts.accountId, accountId)));
        }
        else {
            // Back to draft, and the approval stamp is cleared: a post that was approved,
            // edited and sent back round is not still approved.
            await db.update(socialPosts).set({
                status: 'draft', approvedAt: null, approvedByName: null,
            }).where(and(eq(socialPosts.id, post.id), eq(socialPosts.accountId, accountId)));
        }
        await db.insert(socialPublishLog).values(withTenant(accountId, {
            postId: post.id,
            level: decision === 'approve' ? 'info' : 'warn',
            message: (decision === 'approve'
                ? `Approved by ${name}.${comment ? ` "${comment}"` : ''}`
                : `Changes asked for by ${name}: "${comment}"`).slice(0, 1000),
        }));
        // The person who wrote it is the person who has to act on it. Notifying a whole
        // workspace about one client comment is how people learn to ignore notifications.
        if (post.createdBy) {
            await notifyUsers(accountId, [post.createdBy], {
                kind: 'social_approval',
                title: decision === 'approve' ? `${name} approved a post` : `${name} asked for changes`,
                body: decision === 'approve'
                    ? `"${post.title}" is signed off and ready to schedule.`
                    : `"${post.title}": ${comment}`,
                url: '/?v=social',
            });
        }
        return { ok: true, outcome: decision === 'approve' ? 'approved' : 'changes' };
    });
}
//# sourceMappingURL=socialApproval.js.map