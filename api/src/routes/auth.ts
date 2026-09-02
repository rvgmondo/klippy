import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import { accounts, users, memberships, invitations } from '../db/schema.js';
import { getMembership, workspacesFor, addMember } from '../lib/membership.js';
import { seedNewAccount } from '../lib/seed.js';
import {
  COOKIE_NAME, cookieOptions, hashPassword, verifyPassword, signToken, slugify,
  signTwoFactorTicket, verifyTwoFactorTicket,
  LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_SECONDS,
} from '../lib/auth.js';
import { authOf } from '../lib/context.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { encryptSecret, decryptSecret, secretsAvailable } from '../lib/secretbox.js';
import { sendMail, appUrl } from '../lib/mailer.js';
import { publicAccount } from '../lib/publicAccount.js';
import { blueprint, provisionFrom } from '../lib/blueprints.js';
import { isKnownCurrency } from '../lib/currency.js';
import { authLimiter } from '../lib/rateLimit.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const signupSchema = z.object({
  accountName: z.string().trim().min(1, 'Your business name is required').max(150),
  name: z.string().trim().min(1, 'Your name is required').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(150),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  // What kind of business, so the FIRST business gets the tailoring the second
  // always got: signup never asked, hard-coding every first business to
  // 'services' while the 6-archetype picker sat one screen too deep.
  blueprint: z.string().trim().max(40).optional(),
  currency: z.string().trim().length(3).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(150),
  password: z.string().min(1).max(200),
});

function publicUser(u: typeof users.$inferSelect, role: 'owner' | 'admin' | 'member', accountId: number) {
  return { id: u.id, name: u.name, email: u.email, role, accountId, dailyDigest: u.dailyDigest, theme: u.theme, accent: u.accent };
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = slugify(base);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? slug : `${slug}-${n}`;
    const [existing] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.slug, candidate)).limit(1);
    if (!existing) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

export async function authRoutes(app: FastifyInstance) {
  // ---- Signup: creates a new account + its owner user ----------------------
  app.post('/api/v1/auth/signup', { preHandler: authLimiter('auth-signup') }, async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' });
    }
    const { accountName, name, email, password } = parsed.data;
    const bp = blueprint(parsed.data.blueprint);
    const prov = bp ? provisionFrom(bp) : null;
    const currency = parsed.data.currency && isKnownCurrency(parsed.data.currency)
      ? parsed.data.currency.toUpperCase() : undefined;

    // Email is globally unique for now (unambiguous email+password login).
    const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (dupe) return reply.code(409).send({ error: 'An account with that email already exists.' });

    const slug = await uniqueSlug(accountName);
    const passwordHash = await hashPassword(password);

    const result = await db.transaction(async (tx) => {
      const accIns = await tx.insert(accounts).values({ name: accountName, slug, ...(currency ? { currency } : {}) });
      const accountId = Number(accIns[0].insertId);
      const userIns = await tx.insert(users).values({
        name, email, passwordHash, lastLogin: new Date(),
      });
      const userId = Number(userIns[0].insertId);
      await tx.insert(memberships).values({ accountId, userId, role: 'owner' });
      await seedNewAccount(tx, accountId, userId, accountName, prov?.type, prov?.modules ?? null);
      return { accountId, userId };
    });

    const [account] = await db.select().from(accounts).where(eq(accounts.id, result.accountId)).limit(1);
    const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
    if (!account || !user) return reply.code(500).send({ error: 'Signup failed.' });

    const token = signToken({ uid: user.id, aid: account.id, role: 'owner', se: 0 });
    reply.setCookie(COOKIE_NAME, token, cookieOptions());
    return reply.code(201).send({ user: publicUser(user, 'owner', account.id), account: publicAccount(account) });
  });

  // ---- Login ---------------------------------------------------------------
  app.post('/api/v1/auth/login', { preHandler: authLimiter('auth-login') }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter your email and password.' });
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      // Equalize timing so "no such user" isn't distinguishable.
      await verifyPassword(password, '$2a$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu');
      return reply.code(401).send({ error: 'Invalid email or password.' });
    }
    if (!user.isActive) return reply.code(403).send({ error: 'This account has been deactivated.' });
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const mins = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000));
      return reply.code(429).send({ error: `Too many failed attempts. Try again in ${mins} minute(s).` });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      let attempts = user.failedAttempts + 1;
      let lockedUntil: Date | null = null;
      if (attempts >= LOGIN_MAX_ATTEMPTS) {
        lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_SECONDS * 1000);
        attempts = 0;
      }
      await db.update(users).set({ failedAttempts: attempts, lockedUntil }).where(eq(users.id, user.id));
      return reply.code(401).send({ error: 'Invalid email or password.' });
    }

    const spaces = await workspacesFor(user.id);
    if (!spaces.length) {
      // A refusal with no way past it is a dead end, and this one is reachable in
      // ordinary use: leaving your last workspace, or having one deleted, leaves the
      // login standing with nothing to sign in to. If someone has invited them back,
      // say so, because accepting that invitation is the way out.
      const [pending] = await db.select({ id: invitations.id }).from(invitations)
        .where(and(eq(invitations.email, user.email),
          isNull(invitations.acceptedAt), isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date())))
        .limit(1);
      return reply.code(403).send({
        error: pending
          ? 'Your password is right, but this login is not in a workspace yet. You have an invitation waiting: open the link in that email to join.'
          : 'This login is not in any workspace yet. Ask someone in the workspace to invite you.',
        ...(pending ? { pendingInvitation: true } : {}),
      });
    }
    const first = spaces[0]!;
    const [account] = await db.select().from(accounts).where(eq(accounts.id, first.accountId)).limit(1);
    if (!account || account.status !== 'active') {
      return reply.code(403).send({ error: 'This workspace is not active.' });
    }

    // Password proven: with 2FA on, stop here and hand back a short-lived ticket
    // instead of a session. The cookie is only set once the code checks out.
    if (user.totpEnabledAt && user.totpSecretEnc) {
      await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
      return reply.send({
        twoFactorRequired: true,
        ticket: signTwoFactorTicket({ uid: user.id, aid: account.id, role: first.role, se: user.sessionEpoch }),
      });
    }

    await db.update(users)
      .set({ failedAttempts: 0, lockedUntil: null, lastLogin: new Date() })
      .where(eq(users.id, user.id));

    const token = signToken({ uid: user.id, aid: account.id, role: first.role, se: user.sessionEpoch });
    reply.setCookie(COOKIE_NAME, token, cookieOptions());
    return reply.send({ user: publicUser(user, first.role, account.id), account: publicAccount(account) });
  });

  // ---- Second factor: turn a ticket plus a code into a session -------------
  app.post('/api/v1/auth/2fa/verify', { preHandler: authLimiter('auth-2fa') }, async (req, reply) => {
    const parsed = z.object({ ticket: z.string().min(10), code: z.string().trim().min(6).max(8) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the 6-digit code from your authenticator app.' });
    const t = verifyTwoFactorTicket(parsed.data.ticket);
    if (!t) return reply.code(401).send({ error: 'This sign-in attempt has expired. Start again.' });

    const [user] = await db.select().from(users).where(eq(users.id, t.uid)).limit(1);
    if (!user || !user.isActive || !user.totpSecretEnc || !user.totpEnabledAt) {
      return reply.code(401).send({ error: 'This sign-in attempt has expired. Start again.' });
    }
    // A password change between ticket and code kills the ticket too.
    if (user.sessionEpoch !== (t.se ?? 0)) {
      return reply.code(401).send({ error: 'This sign-in attempt has expired. Start again.' });
    }
    if (!verifyTotp(decryptSecret(user.totpSecretEnc), parsed.data.code)) {
      return reply.code(401).send({ error: 'That code is not right. Codes change every 30 seconds; try the current one.' });
    }

    const [account] = await db.select().from(accounts).where(eq(accounts.id, t.aid)).limit(1);
    if (!account || account.status !== 'active') return reply.code(403).send({ error: 'This workspace is not active.' });

    await db.update(users).set({ lastLogin: new Date() }).where(eq(users.id, user.id));
    reply.setCookie(COOKIE_NAME, signToken({ uid: user.id, aid: t.aid, role: t.role, se: user.sessionEpoch }), cookieOptions());
    return reply.send({ user: publicUser(user, t.role, t.aid), account: publicAccount(account) });
  });

  // ---- Forgot password: email a reset link ---------------------------------
  app.post('/api/v1/auth/forgot', { preHandler: authLimiter('auth-forgot') }, async (req, reply) => {
    const parsed = z.object({ email: z.string().trim().toLowerCase().email() }).safeParse(req.body);
    // Always respond the same way so emails can't be enumerated.
    const generic = { ok: true, message: 'If that email has an account, a reset link is on its way.' };
    if (!parsed.success) return reply.send(generic);

    const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
    if (user && user.isActive) {
      const raw = randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await db.update(users).set({ resetTokenHash: sha256(raw), resetExpires: expires }).where(eq(users.id, user.id));
      const token = `${user.id}.${raw}`;
      const link = `${appUrl()}/?reset=${token}`;
      await sendMail(user.email, 'Reset your Klippy password',
        `Hi ${user.name},\n\nUse this link to reset your password (valid for 1 hour):\n${link}\n\nIf you didn't request this, ignore this email.`);
    }
    return reply.send(generic);
  });

  // ---- Reset password with the emailed token -------------------------------
  app.post('/api/v1/auth/reset', { preHandler: authLimiter('auth-reset') }, async (req, reply) => {
    const parsed = z.object({
      token: z.string().min(10),
      password: z.string().min(8, 'Password must be at least 8 characters').max(200),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [idPart, raw] = parsed.data.token.split('.');
    const userId = Number(idPart);
    if (!Number.isInteger(userId) || !raw) return reply.code(400).send({ error: 'Invalid or expired reset link.' });

    const [user] = await db.select().from(users)
      .where(and(eq(users.id, userId), gt(users.resetExpires, new Date()))).limit(1);
    if (!user || !user.resetTokenHash || user.resetTokenHash !== sha256(raw)) {
      return reply.code(400).send({ error: 'Invalid or expired reset link. Request a new one.' });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    // The epoch bump signs out every existing session. A reset usually means the
    // password may be in someone else's hands; their sessions die with it.
    await db.update(users).set({
      passwordHash, resetTokenHash: null, resetExpires: null, failedAttempts: 0, lockedUntil: null,
      sessionEpoch: user.sessionEpoch + 1,
    }).where(eq(users.id, user.id));
    return reply.send({ ok: true });
  });

  // ---- Logout --------------------------------------------------------------
  app.post('/api/v1/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.send({ ok: true });
  });

  /**
   * Sign out everywhere else. Bumps the session epoch, which kills every token
   * issued before this moment (other browsers, other machines, a laptop left on a
   * train), then re-issues THIS session under the new epoch so the person asking
   * stays signed in.
   */
  app.post('/api/v1/auth/logout-all', { preHandler: app.requireAuth }, async (req, reply) => {
    const { userId, accountId, role } = authOf(req);
    const [me] = await db.select({ se: users.sessionEpoch }).from(users).where(eq(users.id, userId)).limit(1);
    const next = (me?.se ?? 0) + 1;
    await db.update(users).set({ sessionEpoch: next }).where(eq(users.id, userId));
    reply.setCookie(COOKIE_NAME, signToken({ uid: userId, aid: accountId, role, se: next }), cookieOptions());
    return { ok: true };
  });

  // ---- Two-factor management ----------------------------------------------
  app.get('/api/v1/auth/2fa', { preHandler: app.requireAuth }, async (req) => {
    const { userId } = authOf(req);
    const [u] = await db.select({ enc: users.totpSecretEnc, on: users.totpEnabledAt })
      .from(users).where(eq(users.id, userId)).limit(1);
    return { enabled: !!u?.on, pending: !!u?.enc && !u?.on };
  });

  /**
   * Start 2FA setup: generate a secret, store it encrypted but NOT yet enabled.
   * Enabling requires proving a code first, so a half-scanned QR can never lock
   * anyone out of their own account.
   */
  app.post('/api/v1/auth/2fa/setup', { preHandler: app.requireAuth }, async (req, reply) => {
    const { userId } = authOf(req);
    if (!secretsAvailable()) {
      return reply.code(400).send({ error: 'The server has no PAYMENTS_SECRET configured, so encrypted secrets are off.' });
    }
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return reply.code(404).send({ error: 'Account not found.' });
    if (u.totpEnabledAt) return reply.code(400).send({ error: 'Two-factor is already on. Turn it off first to re-set it up.' });
    const secret = generateTotpSecret();
    await db.update(users).set({ totpSecretEnc: encryptSecret(secret), totpEnabledAt: null }).where(eq(users.id, userId));
    return { secret, otpauth: otpauthUrl(secret, u.email) };
  });

  app.post('/api/v1/auth/2fa/enable', { preHandler: app.requireAuth }, async (req, reply) => {
    const { userId } = authOf(req);
    const parsed = z.object({ code: z.string().trim().min(6).max(8) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the 6-digit code from your authenticator app.' });
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u?.totpSecretEnc) return reply.code(400).send({ error: 'Start setup first.' });
    if (u.totpEnabledAt) return reply.code(400).send({ error: 'Two-factor is already on.' });
    if (!verifyTotp(decryptSecret(u.totpSecretEnc), parsed.data.code)) {
      return reply.code(400).send({ error: 'That code is not right. Codes change every 30 seconds; try the current one.' });
    }
    await db.update(users).set({ totpEnabledAt: new Date() }).where(eq(users.id, userId));
    return { ok: true };
  });

  /** Turning 2FA off requires a current code: possession, not just a session. */
  app.post('/api/v1/auth/2fa/disable', { preHandler: app.requireAuth }, async (req, reply) => {
    const { userId } = authOf(req);
    const parsed = z.object({ code: z.string().trim().min(6).max(8) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the 6-digit code from your authenticator app.' });
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u?.totpSecretEnc || !u.totpEnabledAt) return reply.code(400).send({ error: 'Two-factor is not on.' });
    if (!verifyTotp(decryptSecret(u.totpSecretEnc), parsed.data.code)) {
      return reply.code(400).send({ error: 'That code is not right. Codes change every 30 seconds; try the current one.' });
    }
    await db.update(users).set({ totpSecretEnc: null, totpEnabledAt: null }).where(eq(users.id, userId));
    return { ok: true };
  });

  // ---- Current user --------------------------------------------------------
  app.get('/api/v1/auth/me', { preHandler: app.requireAuth }, async (req, reply) => {
    const { userId, accountId } = req.auth!;
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || !user.isActive) return reply.code(401).send({ error: 'Not authenticated.' });
    const m = await getMembership(accountId, userId);
    if (!m || !m.isActive) return reply.code(401).send({ error: 'Not authenticated.' });
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account) return reply.code(401).send({ error: 'Not authenticated.' });
    return reply.send({
      user: publicUser(user, m.role, account.id),
      account: publicAccount(account),
      workspaces: await workspacesFor(userId),
    });
  });
}
