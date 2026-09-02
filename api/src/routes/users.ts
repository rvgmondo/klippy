import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, memberships } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { hashPassword, verifyPassword, COOKIE_NAME, signToken, cookieOptions, verifyToken } from '../lib/auth.js';
import { intId } from '../lib/http.js';
import { membersOf, getMembership, addMember } from '../lib/membership.js';
import { invitations } from '../db/schema.js';
import { issueInvitation, sendInvitationEmail, acceptInvitation } from '../lib/invites.js';
import { isNull, desc } from 'drizzle-orm';

/** Active owners/admins in a workspace, optionally ignoring one person. */
async function activeAdminCount(accountId: number, excludeUserId?: number): Promise<number> {
  const [row] = await db.select({ c: sql<number>`COUNT(*)` }).from(memberships)
    .where(and(
      eq(memberships.accountId, accountId),
      eq(memberships.isActive, true),
      sql`role IN ('owner','admin')`,
      excludeUserId ? ne(memberships.userId, excludeUserId) : undefined,
    ));
  return Number(row?.c ?? 0);
}

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // People in THIS workspace (drives the assignee picker and the People tab).
  app.get('/api/v1/users', async (req) => {
    const { accountId } = authOf(req);
    return { users: await membersOf(accountId) };
  });

  // Update your OWN profile. Applies to your login everywhere, not per workspace.
  app.patch('/api/v1/profile', async (req, reply) => {
    const { userId } = authOf(req);
    const parsed = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      currentPassword: z.string().min(1).max(200).optional(),
      newPassword: z.string().min(8, 'New password must be at least 8 characters').max(200).optional(),
      dailyDigest: z.boolean().optional(),
      theme: z.enum(['system','dark','light']).optional(),
      accent: z.string().trim().max(20).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [me] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!me) return reply.code(404).send({ error: 'Account not found.' });

    const patch: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.dailyDigest !== undefined) patch.dailyDigest = parsed.data.dailyDigest;
    if (parsed.data.theme !== undefined) patch.theme = parsed.data.theme;
    if (parsed.data.accent !== undefined) patch.accent = parsed.data.accent;

    if (parsed.data.newPassword) {
      if (!parsed.data.currentPassword) {
        return reply.code(400).send({ error: 'Enter your current password to change it.' });
      }
      const ok = await verifyPassword(parsed.data.currentPassword, me.passwordHash);
      if (!ok) return reply.code(403).send({ error: 'Your current password is not correct.' });
      patch.passwordHash = await hashPassword(parsed.data.newPassword);
      // New password, new epoch: every OTHER session dies. The cookie below keeps
      // this one alive under the new number.
      patch.sessionEpoch = me.sessionEpoch + 1;
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'Nothing to update.' });

    await db.update(users).set(patch).where(eq(users.id, userId));
    if (parsed.data.newPassword) {
      const { accountId, role } = authOf(req);
      reply.setCookie(COOKIE_NAME, signToken({ uid: userId, aid: accountId, role, se: me.sessionEpoch + 1 }), cookieOptions());
    }
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return { user: u ? { id: u.id, name: u.name, email: u.email, dailyDigest: u.dailyDigest, theme: u.theme, accent: u.accent } : null };
  });

  /**
   * Add someone to THIS workspace.
   * If the email already has a Klippy login (maybe in another workspace), we
   * simply grant them membership here. Only brand-new emails need a password.
   */
  app.post('/api/v1/users', async (req, reply) => {
    const { accountId, userId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can add people.' });
    const parsed = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      email: z.string().trim().toLowerCase().email().max(150),
      password: z.string().min(8).max(200).optional(),
      role: z.enum(['admin', 'member']).default('member'),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [existing] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);

    if (existing) {
      const current = await getMembership(accountId, existing.id);
      if (current?.isActive) return reply.code(409).send({ error: 'That person is already in this workspace.' });
      /**
       * A login that is not already in THIS workspace is invited, never conscripted.
       *
       * The old rule was "no membership in another workspace", and a login with NO
       * memberships at all passed it. That state is reachable in ordinary use, since
       * leaving your last workspace or having one deleted removes the membership rows
       * and leaves the login standing. So the sequence was: spin up a throwaway
       * workspace, add the person by email (membership granted on the spot), then
       * reset their password through PATCH, which asks only for a membership here.
       * That is a cross-tenant account takeover built out of two ordinary buttons.
       *
       * `current` is any membership row in this account, active or switched off, so
       * re-adding someone this workspace already knows still works without a round
       * trip. Everyone else gets an invitation they accept themselves.
       */
      if (!current) {
        const invite = await issueInvitation(accountId, parsed.data.email, parsed.data.role, userId);
        if (invite) {
          const [inviter] = await db.select({ name: users.name }).from(users)
            .where(eq(users.id, userId)).limit(1);
          await sendInvitationEmail(accountId, parsed.data.email, invite.raw, inviter?.name ?? null);
        }
        // The same answer whether or not a mail actually went out just now, so this
        // is not a way to probe who is already invited.
        return reply.code(202).send({
          invited: true,
          email: parsed.data.email,
          message: 'That email already has a Klippy login, so we have invited them instead. They join by accepting it, and their password stays theirs.',
        });
      }
      await addMember(accountId, existing.id, parsed.data.role);
      return reply.code(201).send({
        user: { id: existing.id, name: existing.name, email: existing.email, role: parsed.data.role, isActive: true },
        existingLogin: true,
      });
    }

    if (!parsed.data.name || !parsed.data.password) {
      return reply.code(400).send({ error: 'New people need a name and a starting password.' });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const ins = await db.insert(users).values({
      name: parsed.data.name, email: parsed.data.email, passwordHash,
    });
    const newUserId = Number(ins[0].insertId);
    await addMember(accountId, newUserId, parsed.data.role);
    return reply.code(201).send({
      user: { id: newUserId, name: parsed.data.name, email: parsed.data.email, role: parsed.data.role, isActive: true },
      existingLogin: false,
    });
  });

  /**
   * Change someone's role or remove them FROM THIS WORKSPACE ONLY. Their login
   * and their access to other workspaces are untouched.
   */
  app.patch('/api/v1/users/:id', async (req, reply) => {
    const { accountId, userId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can edit people.' });
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      role: z.enum(['admin', 'member']).optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(8).max(200).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const target = await getMembership(accountId, id);
    if (!target) return reply.code(404).send({ error: 'That person is not in this workspace.' });
    if (target.role === 'owner' && (parsed.data.role || parsed.data.isActive === false)) {
      return reply.code(403).send({ error: 'The workspace owner cannot be demoted or removed.' });
    }
    if ((parsed.data.isActive === false || parsed.data.role === 'member') && target.role !== 'member') {
      if (await activeAdminCount(accountId, id) === 0) {
        return reply.code(400).send({ error: 'There must be at least one active admin.' });
      }
    }
    if (parsed.data.isActive === false && id === userId) {
      return reply.code(400).send({ error: "You can't remove yourself." });
    }

    const memPatch: Record<string, unknown> = {};
    if (parsed.data.role !== undefined) memPatch.role = parsed.data.role;
    if (parsed.data.isActive !== undefined) memPatch.isActive = parsed.data.isActive;
    if (Object.keys(memPatch).length) {
      await db.update(memberships).set(memPatch).where(eq(memberships.id, target.id));
    }
    // A password reset writes the person's GLOBAL login, not a per-workspace one,
    // so it is fenced hard. Without this fence the route was a full cross-tenant
    // account takeover: sign up, spin up a throwaway workspace (instant owner),
    // add a victim by email (POST /users silently made them a member), then reset
    // their password here and sign in as them. Two rules close it:
    //   1. Only a login that belongs to THIS account and nowhere else can be
    //      reset. A login that also exists in another workspace is an independent
    //      identity; this admin has no authority over its credential.
    //   2. An admin cannot reset the OWNER's password (only the owner themselves
    //      can), or resetting it would promote admin to owner.
    if (parsed.data.password) {
      const otherRows = await db.select({ other: sql<number>`count(*)` }).from(memberships)
        .where(and(eq(memberships.userId, id), ne(memberships.accountId, accountId)));
      if (Number(otherRows[0]?.other ?? 0) > 0) {
        return reply.code(403).send({
          error: 'This person has a Klippy login they use in another workspace, so their password is theirs to change. Send them to the sign-in page to reset it.',
        });
      }
      if (target.role === 'owner' && id !== userId) {
        return reply.code(403).send({ error: "You can't reset the workspace owner's password." });
      }
      // Bump the session epoch, exactly as a self-service reset does, so any
      // session opened under the old password dies now rather than lingering for
      // up to a week. Defence in depth: even a permitted reset should not leave a
      // stale session behind.
      const [me] = await db.select({ se: users.sessionEpoch }).from(users).where(eq(users.id, id)).limit(1);
      await db.update(users).set({
        passwordHash: await hashPassword(parsed.data.password), failedAttempts: 0, lockedUntil: null,
        sessionEpoch: (me?.se ?? 0) + 1,
      }).where(eq(users.id, id));
    }

    const updated = (await membersOf(accountId)).find((m) => m.id === id) ?? null;
    return { user: updated };
  });

  /** Invitations this workspace has out, so they can be chased or withdrawn. */
  app.get('/api/v1/invitations', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can see invitations.' });
    const rows = await db.select({
      id: invitations.id, email: invitations.email, role: invitations.role,
      expiresAt: invitations.expiresAt, createdAt: invitations.createdAt,
    }).from(invitations)
      .where(and(eq(invitations.accountId, accountId),
        isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .orderBy(desc(invitations.id));
    return { invitations: rows };
  });

  /** Withdraw one. The link stops working immediately. */
  app.delete('/api/v1/invitations/:id', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can withdraw invitations.' });
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    await db.update(invitations).set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, id), eq(invitations.accountId, accountId),
        isNull(invitations.acceptedAt)));
    return { ok: true };
  });
}

/**
 * Accepting an invitation.
 *
 * NOT behind requireAuth, and that is the whole point. Signing in needs a workspace
 * (auth.ts refuses a login that belongs to none), so a person whose only route back
 * in IS this invitation could never reach a route that required a session. Requiring
 * one would have made the invitation a dead end and left the fence with no way past
 * it, which is worse than the hole it closes.
 *
 * So identity is proven one of two ways, and never assumed:
 *   - an existing session, for someone who is already in a workspace, or
 *   - their own email and password, for someone who is not.
 * Either way the address must match the one the invitation was sent to, so a leaked
 * link is worth nothing to whoever finds it.
 */
export async function invitationRoutes(app: FastifyInstance) {
  app.post('/api/v1/invitations/accept', async (req, reply) => {
    const parsed = z.object({
      token: z.string().trim().min(10).max(200),
      email: z.string().trim().toLowerCase().email().max(150).optional(),
      password: z.string().min(8).max(200).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'That invitation link is incomplete.' });

    let userId: number | null = null;
    const cookie = req.cookies?.[COOKIE_NAME];
    const claims = cookie ? verifyToken(cookie) : null;
    if (claims?.uid) {
      // The session epoch is honoured here as it is everywhere else: a token issued
      // before a password change or a "sign out everywhere" is dead, and accepting an
      // invitation is not the place to let one back in.
      const [u] = await db.select({ se: users.sessionEpoch }).from(users)
        .where(eq(users.id, claims.uid)).limit(1);
      if (u && (claims.se ?? 0) === (u.se ?? 0)) userId = claims.uid;
    }
    if (!userId && parsed.data.email && parsed.data.password) {
      const [u] = await db.select({ id: users.id, hash: users.passwordHash, lockedUntil: users.lockedUntil })
        .from(users).where(eq(users.email, parsed.data.email)).limit(1);
      // Same shape of answer whether the address is unknown or the password is wrong,
      // so this is not a way to find out which Klippy logins exist.
      if (!u || (u.lockedUntil && u.lockedUntil > new Date())
        || !(await verifyPassword(parsed.data.password, u.hash))) {
        return reply.code(401).send({ error: 'That email and password do not match.' });
      }
      userId = u.id;
    }
    if (!userId) {
      return reply.code(401).send({
        error: 'Sign in, or send your email and password with the invitation, to accept it.',
      });
    }

    const res = await acceptInvitation(parsed.data.token, userId);
    if (!res.ok) return reply.code(400).send({ error: res.message });

    // Already a member somehow (an invitation raced with being added by hand): the
    // invitation is spent either way, and saying yes twice should not be an error.
    const existing = await getMembership(res.accountId, userId);
    if (existing) {
      if (!existing.isActive) {
        await db.update(memberships).set({ isActive: true }).where(eq(memberships.id, existing.id));
      }
    } else {
      await addMember(res.accountId, userId, res.role);
    }
    return { ok: true, accountId: res.accountId, message: 'You have joined. Switch to it from the workspace menu.' };
  });
}
