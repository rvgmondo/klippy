import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  socialAccounts, socialPosts, socialPostTargets, socialPostMedia,
  socialHashtagSets, socialPublishLog, storageNodes, accounts, folders,
} from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { assertBusinessAccess, businessScope } from '../lib/access.js';
import { storage, MAX_STORAGE_BYTES } from '../lib/storage.js';
import { socialTokensAvailable } from '../lib/social/tokens.js';
import { validatePost } from '../lib/social/validate.js';
import { NETWORKS, type Network, type MediaItem } from '../lib/social/types.js';
import { canAutoPublish, whyNotAutomatic } from '../lib/social/registry.js';
import { canConnect } from '../lib/social/credentials.js';
import { publicMediaUrl } from '../lib/social/mediaUrl.js';
import { appUrl } from '../lib/mailer.js';

/**
 * Planning, approving and scheduling social posts.
 *
 * The publishing itself lives in lib/social/publish.ts and runs from a cron; this
 * file is everything a person does before that minute arrives, and everything they do
 * when it did not work.
 *
 * The one rule worth stating up front: NOTHING HERE EVER RETURNS A TOKEN. Connected
 * accounts come back as a name, a network and a status. The credential stays on the
 * server, encrypted, and is read only by the publisher.
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const networkEnum = z.enum(['instagram', 'facebook', 'linkedin']);

/** Media types a network can actually publish. Anything else is refused at upload. */
const ALLOWED_MEDIA = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/quicktime',
]);

const EDITABLE = new Set(['draft', 'needs_media', 'awaiting_approval', 'approved', 'scheduled', 'failed', 'needs_manual']);

/**
 * Statuses a post can be sent for sign-off from. Anything already scheduled or out is
 * past the point where a client's answer could change it, and asking for one then is
 * asking a question whose answer cannot be honoured.
 */
const APPROVABLE = new Set(['draft', 'needs_media', 'awaiting_approval', 'approved']);

/**
 * The link a client is actually sent.
 *
 * A QUERY STRING, not a path, and that is not a style choice. The static site is
 * served straight off the docroot with no rewrite rule in this repo, so a request for
 * /approve/<token> is a 404 from Apache before any JavaScript loads. Every public link
 * Klippy already sends (portal sign-in, payment returns) is built this way for the
 * same reason. The page also accepts the path form, for a host that does rewrite.
 */
const approvalUrl = (token: string) => `${appUrl()}/?approve=${token}`;

/**
 * Whether a client has signed this post off, as far as its state says.
 *
 * NOT `status === 'approved'` on its own. Only the client's answer sets approved WITH an
 * approvedAt. An edit to a scheduled post used to set 'approved' too, with nobody's
 * approval behind it, and treating that as a sign-off later logged "changed after it
 * was signed off" about a post no client had ever seen.
 */
const isSignedOff = (post: { status: string; approvedAt: Date | null }) =>
  !!post.approvedAt || post.status === 'awaiting_approval';

/**
 * What goes out has just changed: the words, the networks or the pictures.
 *
 * AN APPROVAL COVERS THE PICTURES AS MUCH AS THE WORDS. The client's page leads with
 * the images and the caption sits under them, so swapping a photo after sign-off
 * publishes something nobody agreed to with their name recorded as the approver. On
 * Instagram even REORDERING counts, because a carousel is cropped to the aspect ratio
 * of whichever image leads.
 *
 * The link is withdrawn at the same time, and that is not tidiness. A live token on a
 * draft is how the approval page recognises a post the CLIENT sent back; leaving one
 * behind after a staff edit makes their own page tell them they asked for changes they
 * never wrote, and refuse their answer. One meaning per state.
 *
 * A SCHEDULED post comes off the schedule, which is what an edit to one has always
 * done. What is new is that it says so, lands in draft rather than a made-up 'approved',
 * and gets checked against its networks before it can go back on. Whether an edited
 * post should instead stay scheduled is an open product decision; until it is made,
 * nothing unchecked is published.
 *
 * Returns the columns to set (null when nothing needs to change) and what happened, so
 * the PATCH route can fold it into its own guarded update and a swapped photo ends in
 * exactly the same state as an edited caption.
 */
function afterContentChange(post: { status: string; approvedAt: Date | null }): {
  set: Record<string, unknown> | null; approvalWithdrawn: boolean; unscheduled: boolean;
} {
  const approvalWithdrawn = isSignedOff(post);
  const unscheduled = post.status === 'scheduled';
  const unearnedApproval = post.status === 'approved' && !post.approvedAt;
  if (!approvalWithdrawn && !unscheduled && !unearnedApproval) {
    return { set: null, approvalWithdrawn: false, unscheduled: false };
  }
  return {
    set: { status: 'draft', approvedAt: null, approvedByName: null, approvalToken: null, lockedAt: null, lockToken: null },
    approvalWithdrawn, unscheduled,
  };
}

/** Record in the post's own history what the change did. */
async function logContentChange(accountId: number, postId: number, r: { approvalWithdrawn: boolean; unscheduled: boolean }) {
  const message = r.approvalWithdrawn && r.unscheduled
    ? 'The post changed after it was signed off, so the approval and the link were withdrawn and it came off the schedule. Send it round again, then schedule it.'
    : r.approvalWithdrawn
      ? 'The post changed after it was signed off, so the approval and the link were withdrawn. Send it round again.'
      : r.unscheduled
        ? 'The post changed while it was scheduled, so it came off the schedule. Schedule it again when it is ready.'
        : null;
  if (!message) return;
  await db.insert(socialPublishLog).values(withTenant(accountId, {
    postId, level: 'warn' as const, message,
  } as never));
}

/**
 * For the media routes: apply afterContentChange to the stored post, BEFORE the media
 * itself is changed.
 *
 * Guarded on the status that was read. `lost` means the post moved underneath, most
 * likely because the publisher claimed it, and the caller must then refuse without
 * touching the media: a photo added after the claim would go out unchecked.
 */
async function contentChanged(
  accountId: number, post: { id: number; status: string; approvedAt: Date | null },
): Promise<{ approvalWithdrawn: boolean; unscheduled: boolean; lost: boolean }> {
  const r = afterContentChange(post);
  if (!r.set) return { approvalWithdrawn: false, unscheduled: false, lost: false };
  const res = await db.update(socialPosts).set(r.set)
    .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, post.id), eq(socialPosts.status, post.status as never)));
  if (!res[0].affectedRows) return { approvalWithdrawn: false, unscheduled: false, lost: true };
  await logContentChange(accountId, post.id, r);
  return { approvalWithdrawn: r.approvalWithdrawn, unscheduled: r.unscheduled, lost: false };
}

const MOVED = 'This post changed while you were working on it, possibly because it is going out now. Close it and open it again.';

async function timezoneOf(accountId: number): Promise<string> {
  const [a] = await db.select({ tz: accounts.timezone }).from(accounts)
    .where(eq(accounts.id, accountId)).limit(1);
  return a?.tz || 'Africa/Johannesburg';
}

/** The media of one post, in the shape validation and publishing both want. */
async function mediaOf(accountId: number, postId: number): Promise<MediaItem[]> {
  const rows = await db.select({
    id: socialPostMedia.id, position: socialPostMedia.position,
    mimeType: socialPostMedia.mimeType, width: socialPostMedia.width,
    height: socialPostMedia.height, durationMs: socialPostMedia.durationMs,
    altText: socialPostMedia.altText, publicToken: socialPostMedia.publicToken,
    bytes: storageNodes.size, nodeMime: storageNodes.mimeType, storageKey: storageNodes.storageKey,
  }).from(socialPostMedia)
    .innerJoin(storageNodes, eq(storageNodes.id, socialPostMedia.storageNodeId))
    .where(tenantWhere(socialPostMedia, accountId, eq(socialPostMedia.postId, postId)))
    .orderBy(asc(socialPostMedia.position), asc(socialPostMedia.id));

  return rows.map((r) => ({
    id: r.id, position: r.position,
    mimeType: r.mimeType ?? r.nodeMime,
    width: r.width, height: r.height, durationMs: r.durationMs,
    bytes: r.bytes, altText: r.altText,
    publicUrl: publicMediaUrl(r.publicToken, r.mimeType ?? r.nodeMime),
    storageKey: r.storageKey,
  }));
}

async function targetsOf(accountId: number, postIds: number[]) {
  if (!postIds.length) return [];
  return db.select({
    id: socialPostTargets.id, postId: socialPostTargets.postId,
    network: socialPostTargets.network, status: socialPostTargets.status,
    socialAccountId: socialPostTargets.socialAccountId,
    captionOverride: socialPostTargets.captionOverride,
    permalink: socialPostTargets.permalink, error: socialPostTargets.error,
    publishedAt: socialPostTargets.publishedAt, attempts: socialPostTargets.attempts,
  }).from(socialPostTargets)
    .where(tenantWhere(socialPostTargets, accountId, inArray(socialPostTargets.postId, postIds)));
}

/**
 * Replace a post's targets with the networks asked for.
 *
 * Rows that already published are LEFT ALONE even if the network is dropped from the
 * list. A permalink is a record that something really went out, and rewriting the
 * target list must not be able to erase it.
 *
 * WHICH ACCOUNT A TARGET GOES TO IS SET ONCE, AND NEVER GUESSED.
 *
 * Every save used to re-pick the account for every target from an unordered list of the
 * business's connected accounts, last one wins. The connect screen ticks every Page a
 * Meta login returns, so a business can easily have two Pages on one network, and one
 * idle autosave moved a post to the other one, possibly another client's, and said
 * nothing. Now:
 *
 *  - a target already bound to an account keeps it, even if that account has since
 *    disconnected. The publisher then sends it to a person with the reason, instead of
 *    posting it somewhere nobody chose.
 *  - an unbound target is bound only when exactly ONE account is connected on that
 *    network. With several there is nowhere yet to say which one is meant, so it stays
 *    unbound, goes to a person, and the publisher says why.
 *
 * `bindings` carries accounts over from another post (a duplicate), so a copy goes to
 * the same Page as the original rather than being picked afresh.
 */
async function setTargets(
  accountId: number, postId: number, businessId: number, networks: Network[],
  bindings?: Map<string, number | null>,
): Promise<void> {
  const existing = await db.select({
    id: socialPostTargets.id, network: socialPostTargets.network, status: socialPostTargets.status,
    socialAccountId: socialPostTargets.socialAccountId,
  }).from(socialPostTargets)
    .where(tenantWhere(socialPostTargets, accountId, eq(socialPostTargets.postId, postId)));

  const keep = new Set(networks);
  const published = new Set(existing.filter((e) => e.status === 'published' || e.status === 'manual_done').map((e) => e.network));

  const removable = existing.filter((e) => !keep.has(e.network as Network) && !published.has(e.network));
  if (removable.length) {
    await db.delete(socialPostTargets).where(tenantWhere(socialPostTargets, accountId,
      inArray(socialPostTargets.id, removable.map((r) => r.id))));
  }

  const connected = await db.select({ id: socialAccounts.id, network: socialAccounts.network })
    .from(socialAccounts)
    .where(tenantWhere(socialAccounts, accountId,
      eq(socialAccounts.businessId, businessId), eq(socialAccounts.status, 'connected')));
  const onlyAccount = (n: string): number | null => {
    const list = connected.filter((c) => c.network === n);
    return list.length === 1 ? list[0]!.id : null;
  };

  for (const n of networks) {
    const row = existing.find((e) => e.network === n);
    if (row) {
      // Filled in only when it was never set: an account connected since the post was
      // written, and the only one on that network.
      const only = row.socialAccountId == null ? onlyAccount(n) : null;
      if (only != null) {
        await db.update(socialPostTargets).set({ socialAccountId: only })
          .where(tenantWhere(socialPostTargets, accountId, eq(socialPostTargets.id, row.id)));
      }
      continue;
    }
    await db.insert(socialPostTargets).values(withTenant(accountId, {
      postId, network: n, socialAccountId: bindings?.get(n) ?? onlyAccount(n),
    } as never));
  }
}

export async function socialRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ---- Connected accounts --------------------------------------------------------
  /**
   * What is connected, and what is merely possible.
   *
   * `networks` is always all three, each flagged with whether an account is connected
   * and whether Klippy can publish to it yet. The composer needs that: a network with
   * no adapter is still a valid target for a manual post, and saying so is the
   * difference between a usable calendar and a screen that looks broken until an
   * approval lands weeks later.
   */
  app.get('/api/v1/social/accounts', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select({
      id: socialAccounts.id, businessId: socialAccounts.businessId,
      network: socialAccounts.network, externalId: socialAccounts.externalId,
      displayName: socialAccounts.displayName, avatarUrl: socialAccounts.avatarUrl,
      status: socialAccounts.status, lastError: socialAccounts.lastError,
      tokenExpiresAt: socialAccounts.tokenExpiresAt, lastCheckedAt: socialAccounts.lastCheckedAt,
      // Never the token itself. Disconnecting keeps the row with its tokens wiped, so posts
      // stay pointed at the Page they were for; the screen needs to tell those rows apart.
      disconnected: sql<number>`${socialAccounts.accessTokenEnc} is null`,
    }).from(socialAccounts)
      .where(tenantWhere(socialAccounts, accountId, await businessScope(req, socialAccounts.businessId)))
      .orderBy(asc(socialAccounts.network));

    return {
      accounts: rows.map((r) => ({ ...r, disconnected: !!Number(r.disconnected) })),
      serverReady: socialTokensAvailable(),
      networks: await Promise.all(NETWORKS.map(async (n) => {
        const connected = rows.some((r) => r.network === n && r.status === 'connected');
        // Three separate facts, kept separate because they send a person to three
        // different places: is there an adapter, can this workspace start a
        // connection at all, and has anything actually been connected.
        const connectable = await canConnect(accountId, n);
        const auto = canAutoPublish(n) && connected;
        return {
          network: n,
          connected,
          connectable,
          canAutoPublish: auto,
          note: auto ? 'Klippy posts to this automatically.' : whyNotAutomatic(n, { canConnect: connectable }),
        };
      })),
    };
  });

  // ---- Posts ---------------------------------------------------------------------
  app.get('/api/v1/social/posts', async (req, reply) => {
    const { accountId } = authOf(req);
    const q = z.object({
      from: dateStr.optional(), to: dateStr.optional(),
      businessId: z.coerce.number().int().positive().optional(),
      status: z.string().trim().max(200).optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message });

    const statuses = q.data.status ? q.data.status.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const rows = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId,
        await businessScope(req, socialPosts.businessId),
        q.data.businessId ? eq(socialPosts.businessId, q.data.businessId) : undefined,
        q.data.from ? gte(socialPosts.scheduledAt, new Date(`${q.data.from}T00:00:00.000Z`)) : undefined,
        q.data.to ? lte(socialPosts.scheduledAt, new Date(`${q.data.to}T23:59:59.999Z`)) : undefined,
        statuses.length ? inArray(socialPosts.status, statuses as never) : undefined))
      .orderBy(asc(socialPosts.scheduledAt), asc(socialPosts.id))
      .limit(500);

    const ids = rows.map((r) => r.id);
    const [targets, media] = await Promise.all([
      targetsOf(accountId, ids),
      ids.length
        ? db.select({
            postId: socialPostMedia.postId, id: socialPostMedia.id,
            position: socialPostMedia.position, mimeType: socialPostMedia.mimeType,
            publicToken: socialPostMedia.publicToken, altText: socialPostMedia.altText,
          }).from(socialPostMedia)
            .where(tenantWhere(socialPostMedia, accountId, inArray(socialPostMedia.postId, ids)))
            .orderBy(asc(socialPostMedia.position))
        : Promise.resolve([]),
    ]);

    const byPost = <T extends { postId: number }>(list: T[], id: number) => list.filter((x) => x.postId === id);
    return {
      timezone: await timezoneOf(accountId),
      posts: rows.map((p) => ({
        ...p,
        targets: byPost(targets, p.id),
        media: byPost(media, p.id).map((m) => ({
          ...m, url: publicMediaUrl(m.publicToken, m.mimeType),
        })),
      })),
    };
  });

  app.get('/api/v1/social/posts/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [post] = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;

    const [targets, media, log] = await Promise.all([
      targetsOf(accountId, [id]),
      mediaOf(accountId, id),
      db.select().from(socialPublishLog)
        .where(tenantWhere(socialPublishLog, accountId, eq(socialPublishLog.postId, id)))
        .orderBy(desc(socialPublishLog.id)).limit(50),
    ]);
    return {
      post, targets, media, log,
      timezone: await timezoneOf(accountId),
      // Built here rather than in the browser: the app's public address is a server
      // setting, and a link assembled from whatever host the staff user happens to be
      // on is a link that works for them and 404s for the client.
      approvalUrl: post.approvalToken ? approvalUrl(post.approvalToken) : null,
    };
  });

  const postBody = z.object({
    businessId: z.number().int().positive(),
    folderId: z.number().int().positive().nullable().optional(),
    title: z.string().trim().min(1).max(200),
    caption: z.string().max(20000).nullable().optional(),
    firstComment: z.string().max(5000).nullable().optional(),
    postType: z.enum(['post', 'carousel', 'reel', 'story']).optional(),
    scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    deliveryMode: z.enum(['auto', 'manual']).optional(),
    mediaAsk: z.string().max(2000).nullable().optional(),
    mediaAskDue: dateStr.nullable().optional(),
    networks: z.array(networkEnum).max(3).optional(),
  });

  app.post('/api/v1/social/posts', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = postBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    if (!(await assertBusinessAccess(req, reply, d.businessId, 'member'))) return;

    // A post that asks the client for a photo is not a draft, it is a thing waiting on
    // somebody. Saying so in the status is what makes the media asks list possible.
    const status = d.mediaAsk ? 'needs_media' : 'draft';
    const ins = await db.insert(socialPosts).values(withTenant(accountId, {
      businessId: d.businessId, folderId: d.folderId ?? null,
      title: d.title, caption: d.caption ?? null, firstComment: d.firstComment ?? null,
      postType: d.postType ?? 'post',
      scheduledAt: d.scheduledAt ? new Date(d.scheduledAt) : null,
      timezone: d.timezone ?? await timezoneOf(accountId),
      status, deliveryMode: d.deliveryMode ?? 'auto',
      mediaAsk: d.mediaAsk ?? null, mediaAskDue: d.mediaAskDue ?? null,
      createdBy: userId,
    } as never));
    const id = Number(ins[0].insertId);
    if (d.networks?.length) await setTargets(accountId, id, d.businessId, d.networks);
    return reply.code(201).send({ id });
  });

  app.patch('/api/v1/social/posts/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = postBody.partial({ businessId: true, title: true }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    /**
     * Read, decide, and write guarded on the status that was read. On a lost race, read
     * and decide again, once.
     *
     * The guard is for the publisher: without it an edit landing just after it claimed
     * the post could rewrite the caption of a post going out. But the composer's autosave
     * and its Save button can also overlap, and then the first save rightly moves the
     * post (scheduled to draft) and the second one's guard fails. Refusing that threw the
     * second edit away. Deciding again against the fresh row saves it, while a real claim
     * still fails, because a post being published is not editable.
     */
    for (let attempt = 0; attempt < 2; attempt++) {
      const [post] = await db.select().from(socialPosts)
        .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
      if (!post) return reply.code(404).send({ error: 'Post not found.' });
      if (attempt === 0 && !(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;
      // A post the publisher is holding must not change under it, and one already out
      // cannot be edited back: the words are on somebody's timeline now.
      if (!EDITABLE.has(post.status)) {
        return reply.code(409).send({ error: `This post is ${post.status.replace('_', ' ')} and cannot be edited.` });
      }

      /**
       * Only what actually CHANGED goes into the update.
       *
       * The composer autosaves the whole form 700ms after any keystroke, so most fields in
       * any request are the values already stored. Every one of them used to count as an
       * edit, and any edit to a scheduled post took it off the schedule: moving it to
       * Thursday, renaming it, or changing nothing at all. The publisher only takes posts
       * that are scheduled, so the post silently never went out.
       *
       * Compared with the empty string folded into null, because the composer sends '' for
       * a first comment that was never filled in.
       */
      const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '');
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'caption', 'firstComment', 'postType', 'mediaAsk', 'mediaAskDue', 'deliveryMode', 'timezone', 'folderId'] as const) {
        if (d[k] !== undefined && !same(d[k], post[k])) patch[k] = d[k];
      }
      if (d.scheduledAt !== undefined) {
        const when = d.scheduledAt ? new Date(d.scheduledAt) : null;
        if ((when?.getTime() ?? null) !== (post.scheduledAt?.getTime() ?? null)) patch.scheduledAt = when;
      }

      /**
       * What goes out: the words the client reads, and where they go.
       *
       * The internal title, the media ask, the delivery mode, the folder and the time are
       * left out on purpose. None of them changes what is published, and moving a post an
       * hour later is ordinary work that should neither unschedule it nor need chasing a
       * client again. The publisher reads the time when it picks the post up, so a moved
       * post goes out at the new time.
       */
      const CLIENT_VISIBLE = ['caption', 'firstComment', 'postType'] as const;
      const changedForClient = CLIENT_VISIBLE.some((k) => k in patch)
        // Sorted both sides: picking the same two networks in a different order is not
        // a change, and treating it as one would throw away a real approval.
        || (!!d.networks && [...d.networks].sort().join() !== (await targetsOf(accountId, [id])).map((t) => t.network).sort().join());

      let approvalWithdrawn = false;
      let unscheduled = false;
      if (changedForClient) {
        const r = afterContentChange(post);
        if (r.set) Object.assign(patch, r.set);
        approvalWithdrawn = r.approvalWithdrawn;
        unscheduled = r.unscheduled;
      } else if (post.status === 'scheduled' && 'scheduledAt' in patch && patch.scheduledAt === null) {
        // A scheduled post with no time would vanish: the publisher only takes posts that
        // are due, the calendar only shows posts with a date, and Needs you does not list
        // scheduled ones. Clearing the time takes it off the schedule, and says so. What
        // the client saw is unchanged, so their approval and their link both stand, the
        // same as unscheduling it by hand.
        Object.assign(patch, { status: post.approvedAt ? 'approved' : 'draft', lockedAt: null, lockToken: null });
        unscheduled = true;
      }

      /**
       * A post that STAYS scheduled needs a time still to come.
       *
       * The publisher takes anything scheduled at or before now, so a time in the past is
       * "publish in the next minute". The composer saves the date and the time as they are
       * typed, and changing the date before the time passes through such a moment: a post
       * set for tomorrow at eight, moved to tonight at eight by changing the date first,
       * was briefly this morning at eight, and went out.
       */
      const staysScheduled = post.status === 'scheduled' && patch.status === undefined;
      if (staysScheduled && patch.scheduledAt instanceof Date && patch.scheduledAt.getTime() <= Date.now()) {
        return reply.code(400).send({
          error: 'That time has already passed. A scheduled post keeps its old time until you pick one still to come.',
        });
      }

      if (Object.keys(patch).length) {
        const res = await db.update(socialPosts).set(patch)
          .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id), eq(socialPosts.status, post.status)));
        // Matched rows, not changed ones (the pool reports found rows), so zero means the
        // status moved since the read.
        if (!res[0].affectedRows) {
          if (attempt === 0) continue;
          return reply.code(409).send({ error: MOVED });
        }
        await logContentChange(accountId, id, { approvalWithdrawn, unscheduled });
      }
      if (d.networks) await setTargets(accountId, id, post.businessId, d.networks);
      return { ok: true, approvalWithdrawn, unscheduled };
    }
    return reply.code(409).send({ error: MOVED });
  });

  /**
   * Delete or cancel.
   *
   * A draft is deleted. Anything that has been scheduled is CANCELLED instead, so the
   * calendar keeps the record that something was planned there and then pulled, which
   * is a question clients ask.
   */
  app.delete('/api/v1/social/posts/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [post] = await db.select({ businessId: socialPosts.businessId, status: socialPosts.status })
      .from(socialPosts).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;

    const everWentOut = await db.select({ n: sql<number>`count(*)` }).from(socialPostTargets)
      .where(tenantWhere(socialPostTargets, accountId, eq(socialPostTargets.postId, id),
        inArray(socialPostTargets.status, ['published', 'manual_done'])));

    if (post.status === 'draft' && !Number(everWentOut[0]?.n ?? 0)) {
      await db.delete(socialPosts).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id)));
      return { ok: true, deleted: true };
    }
    await db.update(socialPosts).set({ status: 'cancelled', lockedAt: null, lockToken: null })
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id)));
    return { ok: true, deleted: false, message: 'Cancelled. It stays on the calendar so the history is intact.' };
  });

  app.post('/api/v1/social/posts/:id/duplicate', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [post] = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;

    const ins = await db.insert(socialPosts).values(withTenant(accountId, {
      businessId: post.businessId, folderId: post.folderId,
      title: `${post.title} (copy)`.slice(0, 200),
      caption: post.caption, firstComment: post.firstComment, postType: post.postType,
      // Deliberately unscheduled and back to draft. A copy that inherited the original
      // time would publish itself, which is not what "duplicate" means to anyone.
      scheduledAt: null, timezone: post.timezone, status: 'draft',
      deliveryMode: post.deliveryMode, mediaAsk: post.mediaAsk, mediaAskDue: null,
      createdBy: userId,
    } as never));
    const newId = Number(ins[0].insertId);

    const targets = await targetsOf(accountId, [id]);
    if (targets.length) {
      // The copy goes where the original goes. Picked afresh, it could land on a
      // different Page from the one the original was set to.
      await setTargets(accountId, newId, post.businessId, targets.map((t) => t.network as Network),
        new Map(targets.map((t) => [t.network, t.socialAccountId])));
    }
    // Media rows point at storage nodes, so a copy shares the same files. New tokens,
    // because a token identifies one row and revoking one copy must not break another.
    const media = await db.select().from(socialPostMedia)
      .where(tenantWhere(socialPostMedia, accountId, eq(socialPostMedia.postId, id)));
    for (const m of media) {
      await db.insert(socialPostMedia).values(withTenant(accountId, {
        postId: newId, storageNodeId: m.storageNodeId, position: m.position,
        altText: m.altText, publicToken: randomBytes(32).toString('hex'),
        width: m.width, height: m.height, durationMs: m.durationMs, mimeType: m.mimeType,
      } as never));
    }
    return reply.code(201).send({ id: newId });
  });

  // ---- Media ---------------------------------------------------------------------
  app.post('/api/v1/social/posts/:id/media', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    // The whole row: contentChanged below needs the sign-off fields, not just the status.
    const [post] = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;
    // Same rule as editing the words. A photo added to a post that already went out used
    // to knock it back to draft, erasing that it was published.
    if (!EDITABLE.has(post.status)) {
      return reply.code(409).send({ error: `This post is ${post.status.replace('_', ' ')} and its photos cannot be changed.` });
    }

    const part = await req.file({ limits: { fileSize: MAX_STORAGE_BYTES } });
    if (!part) return reply.code(400).send({ error: 'No file uploaded.' });
    if (!ALLOWED_MEDIA.has(part.mimetype)) {
      return reply.code(400).send({ error: 'Social posts take JPEG, PNG, WebP, GIF, MP4 or MOV.' });
    }

    const ext = path.extname(part.filename).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, '');
    const key = `${accountId}/social/${Date.now()}_${randomBytes(8).toString('hex')}${ext}`;
    const size = await storage().save(key, part.file);
    if (part.file.truncated) {
      await storage().delete(key);
      return reply.code(400).send({ error: 'That file is larger than the 50MB limit.' });
    }

    // A picture the client never saw must not go out under their sign-off, and a
    // scheduled post whose pictures changed has not been checked against its networks.
    // Done before the photo is attached: if the publisher has claimed the post since it
    // was read, the photo is not added at all, rather than going out unchecked.
    const changed = await contentChanged(accountId, post);
    if (changed.lost) {
      await storage().delete(key);
      return reply.code(409).send({ error: MOVED });
    }

    const node = await db.insert(storageNodes).values(withTenant(accountId, {
      parentId: null, kind: 'file' as const, name: part.filename.slice(0, 255),
      storageKey: key, size, mimeType: part.mimetype, uploadedBy: userId,
    } as never));

    const [tail] = await db.select({ next: sql<number>`coalesce(max(${socialPostMedia.position}) + 1, 0)` })
      .from(socialPostMedia)
      .where(tenantWhere(socialPostMedia, accountId, eq(socialPostMedia.postId, id)));
    const next = Number(tail?.next ?? 0);

    const dims = z.object({
      width: z.coerce.number().int().positive().max(100000).optional(),
      height: z.coerce.number().int().positive().max(100000).optional(),
      durationMs: z.coerce.number().int().positive().max(86_400_000).optional(),
      altText: z.string().trim().max(500).optional(),
    }).safeParse(req.query);
    const meta = dims.success ? dims.data : {};

    const ins = await db.insert(socialPostMedia).values(withTenant(accountId, {
      postId: id, storageNodeId: Number(node[0].insertId), position: Number.isFinite(next) ? next : 0,
      altText: meta.altText ?? null,
      // 32 random bytes. This is the credential on the public URL Meta fetches from.
      publicToken: randomBytes(32).toString('hex'),
      width: meta.width ?? null, height: meta.height ?? null,
      durationMs: meta.durationMs ?? null, mimeType: part.mimetype,
    } as never));

    // Media arriving is what un-blocks a post that was waiting for it.
    if (post.status === 'needs_media') {
      await db.update(socialPosts).set({ status: 'draft' })
        .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id), eq(socialPosts.status, 'needs_media')));
    }
    return reply.code(201).send({
      id: Number(ins[0].insertId), media: await mediaOf(accountId, id),
      approvalWithdrawn: changed.approvalWithdrawn, unscheduled: changed.unscheduled,
    });
  });

  app.delete('/api/v1/social/posts/:id/media/:mediaId', async (req, reply) => {
    const { accountId } = authOf(req);
    const p = z.object({ id: z.coerce.number().int().positive(), mediaId: z.coerce.number().int().positive() })
      .safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'Bad id.' });
    const [post] = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, p.data.id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;
    if (!EDITABLE.has(post.status)) {
      return reply.code(409).send({ error: `This post is ${post.status.replace('_', ' ')} and its photos cannot be changed.` });
    }
    // Nothing to remove is not a change, and must not unschedule anything.
    const [photo] = await db.select({ id: socialPostMedia.id }).from(socialPostMedia)
      .where(tenantWhere(socialPostMedia, accountId,
        eq(socialPostMedia.id, p.data.mediaId), eq(socialPostMedia.postId, p.data.id))).limit(1);
    if (!photo) return reply.code(404).send({ error: 'That photo is not on this post.' });

    const changed = await contentChanged(accountId, post);
    if (changed.lost) return reply.code(409).send({ error: MOVED });
    // The link row goes; the file stays. It may be in the client's Files tree, and
    // removing a photo from one post must never delete it from under another.
    await db.delete(socialPostMedia).where(tenantWhere(socialPostMedia, accountId,
      eq(socialPostMedia.id, p.data.mediaId), eq(socialPostMedia.postId, p.data.id)));
    return {
      ok: true, media: await mediaOf(accountId, p.data.id),
      approvalWithdrawn: changed.approvalWithdrawn, unscheduled: changed.unscheduled,
    };
  });

  app.post('/api/v1/social/posts/:id/reorder-media', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({ order: z.array(z.number().int().positive()).max(20) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Send an order array of media ids.' });
    const [post] = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;
    if (!EDITABLE.has(post.status)) {
      return reply.code(409).send({ error: `This post is ${post.status.replace('_', ' ')} and its photos cannot be changed.` });
    }

    // Order matters on Instagram: a carousel is cropped to the aspect ratio of its
    // FIRST image, so which one leads changes how every other one looks. Which is
    // exactly why a reorder throws the sign-off away too.
    const changed = await contentChanged(accountId, post);
    if (changed.lost) return reply.code(409).send({ error: MOVED });
    let position = 0;
    for (const mediaId of parsed.data.order) {
      await db.update(socialPostMedia).set({ position: position++ })
        .where(tenantWhere(socialPostMedia, accountId,
          eq(socialPostMedia.id, mediaId), eq(socialPostMedia.postId, id)));
    }
    return {
      ok: true, media: await mediaOf(accountId, id),
      approvalWithdrawn: changed.approvalWithdrawn, unscheduled: changed.unscheduled,
    };
  });

  // ---- Scheduling ----------------------------------------------------------------
  /**
   * Check a post against every network it is going to, without scheduling it.
   *
   * The composer calls this as the person types, so problems appear next to the field
   * that causes them rather than as a refusal at the end.
   */
  /**
   * Send it to the client for sign-off.
   *
   * The link is a random 32 bytes and nothing else. No email address, no account, no
   * expiry: an approval link that has quietly gone stale is a client who thinks the
   * agency ignored them. It is revoked by withdrawing it, which is one click and
   * takes effect instantly, and one post's link can never open another post.
   *
   * The same link is reused when a post goes round a second time, so a client who
   * asked for changes can go back to the message they already have rather than
   * hunting for a newer one.
   */
  app.post('/api/v1/social/posts/:id/request-approval', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [post] = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;
    if (!APPROVABLE.has(post.status)) {
      return reply.code(409).send({
        error: `This post is ${post.status.replace('_', ' ')}. Only something still being planned can be sent for approval.`,
      });
    }
    if (!(post.caption ?? '').trim()) {
      return reply.code(400).send({ error: 'Write the caption first. There is nothing to approve yet.' });
    }

    const token = post.approvalToken ?? randomBytes(32).toString('hex');
    await db.update(socialPosts).set({
      status: 'awaiting_approval', approvalToken: token,
      // A fresh round starts unsigned, so an old name cannot sit on new words.
      approvedAt: null, approvedByName: null,
    }).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id)));

    await db.insert(socialPublishLog).values(withTenant(accountId, {
      postId: id, level: 'info' as const, message: 'Sent to the client for approval.',
    } as never));

    return { ok: true, approvalUrl: approvalUrl(token) };
  });

  /**
   * Withdraw the link.
   *
   * Nulling the column is the whole revocation: the public route looks the token up
   * in this table, so a withdrawn link stops working the moment this returns, even in
   * a mailbox that already has it.
   */
  app.post('/api/v1/social/posts/:id/revoke-approval', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [post] = await db.select({ businessId: socialPosts.businessId, status: socialPosts.status })
      .from(socialPosts).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;

    await db.update(socialPosts).set({
      approvalToken: null,
      // Only the waiting state goes back. A post already approved keeps its sign-off:
      // withdrawing the link is closing the door, not undoing what was agreed.
      ...(post.status === 'awaiting_approval' ? { status: 'draft' as const } : {}),
    }).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id)));

    await db.insert(socialPublishLog).values(withTenant(accountId, {
      postId: id, level: 'info' as const, message: 'Approval link withdrawn.',
    } as never));
    return { ok: true };
  });

  app.post('/api/v1/social/posts/:id/check', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [post] = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;

    const targets = await targetsOf(accountId, [id]);
    const media = await mediaOf(accountId, id);
    const overrides = Object.fromEntries(targets.map((t) => [t.network, t.captionOverride])) as Partial<Record<Network, string | null>>;
    return validatePost(
      { id: post.id, title: post.title, caption: post.caption ?? '', firstComment: post.firstComment, postType: post.postType },
      media, targets.map((t) => t.network as Network), overrides,
    );
  });

  app.post('/api/v1/social/posts/:id/schedule', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      scheduledAt: z.string().datetime({ offset: true }).optional(),
      timezone: z.string().trim().max(64).optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Send scheduledAt as an ISO time with an offset.' });

    const [post] = await db.select().from(socialPosts)
      .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;

    /**
     * Never schedule a post that is still out for sign-off.
     *
     * Without this the whole approval feature is optional in the worst way: staff send
     * the link, click Schedule while the client is still reading, and the post goes
     * out unanswered. The client then opens their link and is told it was approved,
     * because a scheduled post reads as approved, and there was never a moment they
     * could have said no.
     *
     * Withdrawing the link first is the deliberate way through, and it says so.
     */
    if (post.status === 'awaiting_approval') {
      return reply.code(409).send({
        error: 'This is with the client for sign-off. Wait for their answer, or withdraw the link first.',
      });
    }

    const when = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : post.scheduledAt;
    if (!when) return reply.code(400).send({ error: 'Pick a date and time first.' });

    const targets = await targetsOf(accountId, [id]);
    if (!targets.length) return reply.code(400).send({ error: 'Pick at least one account to post to.' });

    const media = await mediaOf(accountId, id);
    const overrides = Object.fromEntries(targets.map((t) => [t.network, t.captionOverride])) as Partial<Record<Network, string | null>>;
    const check = validatePost(
      { id: post.id, title: post.title, caption: post.caption ?? '', firstComment: post.firstComment, postType: post.postType },
      media, targets.map((t) => t.network as Network), overrides,
    );
    // Refuse with the reasons, not a generic no. The composer shows each against its
    // own field, so this is the difference between a fixable problem and a wall.
    if (!check.ok) return reply.code(400).send({ error: 'This cannot go out yet.', issues: check.issues });

    await db.update(socialPosts).set({
      status: 'scheduled', scheduledAt: when,
      timezone: parsed.data.timezone ?? post.timezone ?? await timezoneOf(accountId),
      lockedAt: null, lockToken: null, attempts: 0,
    }).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id)));

    // Any target left failed from a previous run goes back in the queue with it.
    await db.update(socialPostTargets).set({ status: 'pending', nextAttemptAt: null, error: null })
      .where(tenantWhere(socialPostTargets, accountId,
        eq(socialPostTargets.postId, id), eq(socialPostTargets.status, 'failed')));

    return { ok: true, scheduledAt: when.toISOString(), warnings: check.issues.filter((i) => i.severity === 'warning') };
  });

  app.post('/api/v1/social/posts/:id/unschedule', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [post] = await db.select({
      businessId: socialPosts.businessId, status: socialPosts.status, approvedAt: socialPosts.approvedAt,
    }).from(socialPosts).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;
    if (post.status === 'publishing') {
      return reply.code(409).send({ error: 'This is going out right now and cannot be pulled back.' });
    }
    // Only a scheduled post can come off the schedule. This used to rewrite a published,
    // cancelled or failed post to approved as well, erasing what had happened to it.
    if (post.status !== 'scheduled') {
      return reply.code(409).send({ error: `This post is ${post.status.replace('_', ' ')}, not scheduled.` });
    }
    // Approved only if a client actually approved it.
    const res = await db.update(socialPosts).set({
      status: post.approvedAt ? 'approved' : 'draft', lockedAt: null, lockToken: null,
    }).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id), eq(socialPosts.status, 'scheduled')));
    if (!res[0].affectedRows) {
      return reply.code(409).send({ error: 'This is going out right now and cannot be pulled back.' });
    }
    return { ok: true };
  });

  /**
   * "I posted this myself."
   *
   * The other half of manual delivery, and the reason the whole thing works before a
   * single platform approval exists. A person puts the post up by hand and tells
   * Klippy, optionally with the link, so the calendar and later the analytics know it
   * really went out.
   */
  app.post('/api/v1/social/posts/:id/mark-manual-done', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      network: networkEnum.optional(),
      permalink: z.string().trim().url().max(500).nullable().optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'That link does not look like a URL.' });

    const [post] = await db.select({ businessId: socialPosts.businessId })
      .from(socialPosts).where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id))).limit(1);
    if (!post) return reply.code(404).send({ error: 'Post not found.' });
    if (!(await assertBusinessAccess(req, reply, post.businessId, 'member'))) return;

    await db.update(socialPostTargets).set({
      status: 'manual_done', publishedAt: new Date(),
      permalink: parsed.data.permalink ?? null, error: null,
    }).where(tenantWhere(socialPostTargets, accountId,
      eq(socialPostTargets.postId, id),
      parsed.data.network ? eq(socialPostTargets.network, parsed.data.network) : undefined,
      inArray(socialPostTargets.status, ['pending', 'failed'])));

    // The post is only done when every network is. Marking Instagram done while
    // LinkedIn is still waiting must not close the whole thing.
    const remaining = await db.select({ n: sql<number>`count(*)` }).from(socialPostTargets)
      .where(tenantWhere(socialPostTargets, accountId, eq(socialPostTargets.postId, id),
        inArray(socialPostTargets.status, ['pending', 'publishing', 'failed'])));
    const done = !Number(remaining[0]?.n ?? 0);
    if (done) {
      await db.update(socialPosts).set({ status: 'published', lockedAt: null, lockToken: null })
        .where(tenantWhere(socialPosts, accountId, eq(socialPosts.id, id)));
    }
    await db.insert(socialPublishLog).values(withTenant(accountId, {
      postId: id, level: 'info' as const,
      message: parsed.data.network
        ? `Marked as posted by hand on ${parsed.data.network}.`
        : 'Marked as posted by hand.',
    } as never));
    return { ok: true, complete: done };
  });

  // ---- Hashtag sets --------------------------------------------------------------
  app.get('/api/v1/social/hashtag-sets', async (req) => {
    const { accountId } = authOf(req);
    return {
      sets: await db.select().from(socialHashtagSets)
        .where(tenantWhere(socialHashtagSets, accountId, await businessScope(req, socialHashtagSets.businessId)))
        .orderBy(asc(socialHashtagSets.name)),
    };
  });

  app.post('/api/v1/social/hashtag-sets', async (req, reply) => {
    const { accountId } = authOf(req);
    const parsed = z.object({
      businessId: z.number().int().positive(),
      name: z.string().trim().min(1).max(120),
      tags: z.array(z.string().trim().min(1).max(80)).max(60),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    if (!(await assertBusinessAccess(req, reply, parsed.data.businessId, 'member'))) return;
    const ins = await db.insert(socialHashtagSets).values(withTenant(accountId, {
      businessId: parsed.data.businessId, name: parsed.data.name,
      // Stored without the hash so the composer decides how to render them.
      tags: parsed.data.tags.map((t) => t.replace(/^#+/, '')),
    } as never));
    return reply.code(201).send({ id: Number(ins[0].insertId) });
  });

  app.delete('/api/v1/social/hashtag-sets/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [row] = await db.select({ businessId: socialHashtagSets.businessId }).from(socialHashtagSets)
      .where(tenantWhere(socialHashtagSets, accountId, eq(socialHashtagSets.id, id))).limit(1);
    if (!row) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertBusinessAccess(req, reply, row.businessId, 'member'))) return;
    await db.delete(socialHashtagSets).where(tenantWhere(socialHashtagSets, accountId, eq(socialHashtagSets.id, id)));
    return { ok: true };
  });

  // ---- Import --------------------------------------------------------------------
  /**
   * Load a whole planned calendar in one go.
   *
   * A month of posts already exists in a spreadsheet or a document before Klippy ever
   * sees it. Retyping thirteen posts to try the tool is the reason people do not try
   * the tool, so this takes the plan as it stands and creates the drafts.
   */
  app.post('/api/v1/social/import/calendar', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({
      businessId: z.number().int().positive(),
      folderId: z.number().int().positive().nullable().optional(),
      timezone: z.string().trim().max(64).optional(),
      defaultTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      networks: z.array(networkEnum).min(1).max(3),
      deliveryMode: z.enum(['auto', 'manual']).optional(),
      posts: z.array(z.object({
        date: dateStr,
        time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        title: z.string().trim().min(1).max(200),
        caption: z.string().max(20000).optional(),
        firstComment: z.string().max(5000).optional(),
        postType: z.enum(['post', 'carousel', 'reel', 'story']).optional(),
        mediaAsk: z.string().max(2000).optional(),
        deliveryMode: z.enum(['auto', 'manual']).optional(),
      })).min(1).max(200),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    if (!(await assertBusinessAccess(req, reply, d.businessId, 'member'))) return;

    if (d.folderId != null) {
      const [f] = await db.select({ id: folders.id }).from(folders)
        .where(tenantWhere(folders, accountId, eq(folders.id, d.folderId))).limit(1);
      if (!f) return reply.code(400).send({ error: 'That client folder does not exist.' });
    }

    const tz = d.timezone ?? await timezoneOf(accountId);
    const created: number[] = [];
    for (const p of d.posts) {
      const time = p.time ?? d.defaultTime ?? '09:00';
      // Stored as UTC from a wall-clock time in the workspace zone. The offset is
      // resolved with the zone rather than assumed, so a calendar imported in winter
      // still fires at the right local hour in summer.
      const when = zonedToUtc(`${p.date}T${time}:00`, tz);
      const ins = await db.insert(socialPosts).values(withTenant(accountId, {
        businessId: d.businessId, folderId: d.folderId ?? null,
        title: p.title, caption: p.caption ?? null, firstComment: p.firstComment ?? null,
        postType: p.postType ?? 'post',
        scheduledAt: when, timezone: tz,
        // A post that needs a photo from the client is not ready, and saying so is
        // what puts it on the media asks list instead of looking like a finished draft.
        status: p.mediaAsk ? 'needs_media' : 'draft',
        deliveryMode: p.deliveryMode ?? d.deliveryMode ?? 'auto',
        mediaAsk: p.mediaAsk ?? null,
        createdBy: userId,
      } as never));
      const id = Number(ins[0].insertId);
      await setTargets(accountId, id, d.businessId, d.networks);
      created.push(id);
    }
    return reply.code(201).send({ created: created.length, ids: created, timezone: tz });
  });
}

/**
 * A wall-clock time in a named zone, as a UTC instant.
 *
 * Done with Intl rather than a date library because the app has none, and because the
 * only correct source for "what is the offset in Johannesburg on this date" is the
 * timezone database the runtime already carries. Guessing an offset is how a schedule
 * drifts by an hour for half the year.
 */
export function zonedToUtc(localIso: string, timeZone: string): Date {
  const naive = new Date(`${localIso}Z`);
  if (Number.isNaN(naive.getTime())) return new Date(localIso);
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(naive).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour === '24' ? '00' : parts.hour), Number(parts.minute), Number(parts.second),
    );
    // The difference between reading the instant in that zone and the instant itself
    // IS the offset, so subtracting it turns the wall clock into the real moment.
    return new Date(naive.getTime() - (asUtc - naive.getTime()));
  } catch {
    // An unknown zone must not lose the post; fall back to treating it as UTC.
    return naive;
  }
}
