import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import { accounts, users, memberships } from '../db/schema.js';
import { getMembership, workspacesFor, addMember } from '../lib/membership.js';
import { seedNewAccount } from '../lib/seed.js';
import {
  COOKIE_NAME, cookieOptions, hashPassword, verifyPassword, signToken, slugify,
  LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_SECONDS,
} from '../lib/auth.js';
import { sendMail, appUrl } from '../lib/mailer.js';
import { publicAccount } from '../lib/publicAccount.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const signupSchema = z.object({
  accountName: z.string().trim().min(1, 'Workspace name is required').max(150),
  name: z.string().trim().min(1, 'Your name is required').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(150),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
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
  app.post('/api/v1/auth/signup', async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' });
    }
    const { accountName, name, email, password } = parsed.data;

    // Email is globally unique for now (unambiguous email+password login).
    const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (dupe) return reply.code(409).send({ error: 'An account with that email already exists.' });

    const slug = await uniqueSlug(accountName);
    const passwordHash = await hashPassword(password);

    const result = await db.transaction(async (tx) => {
      const accIns = await tx.insert(accounts).values({ name: accountName, slug });
      const accountId = Number(accIns[0].insertId);
      const userIns = await tx.insert(users).values({
        name, email, passwordHash, lastLogin: new Date(),
      });
      const userId = Number(userIns[0].insertId);
      await tx.insert(memberships).values({ accountId, userId, role: 'owner' });
      await seedNewAccount(tx, accountId, userId, accountName);
      return { accountId, userId };
    });

    const [account] = await db.select().from(accounts).where(eq(accounts.id, result.accountId)).limit(1);
    const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
    if (!account || !user) return reply.code(500).send({ error: 'Signup failed.' });

    const token = signToken({ uid: user.id, aid: account.id, role: 'owner' });
    reply.setCookie(COOKIE_NAME, token, cookieOptions());
    return reply.code(201).send({ user: publicUser(user, 'owner', account.id), account: publicAccount(account) });
  });

  // ---- Login ---------------------------------------------------------------
  app.post('/api/v1/auth/login', async (req, reply) => {
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
      return reply.code(403).send({ error: 'This login is not in any workspace yet.' });
    }
    const first = spaces[0]!;
    const [account] = await db.select().from(accounts).where(eq(accounts.id, first.accountId)).limit(1);
    if (!account || account.status !== 'active') {
      return reply.code(403).send({ error: 'This workspace is not active.' });
    }

    await db.update(users)
      .set({ failedAttempts: 0, lockedUntil: null, lastLogin: new Date() })
      .where(eq(users.id, user.id));

    const token = signToken({ uid: user.id, aid: account.id, role: first.role });
    reply.setCookie(COOKIE_NAME, token, cookieOptions());
    return reply.send({ user: publicUser(user, first.role, account.id), account: publicAccount(account) });
  });

  // ---- Forgot password: email a reset link ---------------------------------
  app.post('/api/v1/auth/forgot', async (req, reply) => {
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
  app.post('/api/v1/auth/reset', async (req, reply) => {
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
    await db.update(users).set({
      passwordHash, resetTokenHash: null, resetExpires: null, failedAttempts: 0, lockedUntil: null,
    }).where(eq(users.id, user.id));
    return reply.send({ ok: true });
  });

  // ---- Logout --------------------------------------------------------------
  app.post('/api/v1/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.send({ ok: true });
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
