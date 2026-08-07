import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { portalLoginTokens, portalUsers, folders, businesses } from '../db/schema.js';
import { hashPassword, verifyPassword } from './auth.js';

/**
 * Signing clients in to their own portal.
 *
 * The portal is the only part of Klippy a stranger can reach, and what sits behind
 * it is a client's financial history. So a few rules that are not negotiable:
 *
 *  - A portal token is NOT a staff token. Different cookie, and an `aud` claim that
 *    is checked on the way back in, so neither can ever be presented as the other
 *    even though both are signed with the same secret.
 *  - Sign-in links are single use, short lived, and stored only as a SHA-256. A
 *    leaked database yields no working links, which matters more here than for a
 *    password reset because the link IS the credential.
 *  - Asking for a link never reveals whether an address is on file. The answer is
 *    the same either way, or the portal becomes a way to enumerate a rival's
 *    client list.
 *  - The account is re-read on every request rather than trusted from the token,
 *    so switching a client off takes effect immediately instead of whenever their
 *    token happens to expire.
 */

const SECRET = process.env.JWT_SECRET;
export const PORTAL_COOKIE = 'klippy_portal';
const PORTAL_AUDIENCE = 'klippy-portal';
const TOKEN_TTL = '30d';
/** Long enough to arrive and be clicked, short enough that a forwarded mail is stale. */
export const LINK_TTL_MINUTES = 30;
/** Mirrors the staff login policy, because the portal is the more exposed door. */
export const PORTAL_MAX_ATTEMPTS = 6;
export const PORTAL_LOCKOUT_SECONDS = 15 * 60;
/** Shortest gap between sign-in emails to one address. */
export const LINK_MIN_GAP_SECONDS = 60;

export interface PortalTokenPayload {
  pid: number;   // portal user id, or 0 for a staff preview
  aid: number;   // account id
  fid: number;   // folder (client) id
  bid: number;   // business id
  /** 1 when this is a staff member looking, not the client. */
  prv?: 1;
}

/**
 * A staff preview expires quickly. It is a look at someone else's account, so it
 * should not survive the sitting in which it was opened.
 */
const PREVIEW_TTL = '30m';

export function signPreviewToken(p: Omit<PortalTokenPayload, 'pid' | 'prv'>): string {
  return jwt.sign({ ...p, pid: 0, prv: 1 }, SECRET as string,
    { expiresIn: PREVIEW_TTL, audience: PORTAL_AUDIENCE });
}

export function signPortalToken(p: PortalTokenPayload): string {
  return jwt.sign(p, SECRET as string, { expiresIn: TOKEN_TTL, audience: PORTAL_AUDIENCE });
}

export function verifyPortalToken(token: string): PortalTokenPayload | null {
  try {
    return jwt.verify(token, SECRET as string, { audience: PORTAL_AUDIENCE }) as PortalTokenPayload;
  } catch {
    return null;
  }
}

export function portalCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProd,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
}

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Normalise the way an address is compared, so casing and stray spaces do not lock anyone out. */
export const normaliseEmail = (e: string) => e.trim().toLowerCase();

export interface PortalContext {
  user: typeof portalUsers.$inferSelect;
  client: typeof folders.$inferSelect;
  business: typeof businesses.$inferSelect;
  /**
   * True when a staff member is looking rather than the client.
   *
   * Everything readable stays readable, and everything that WRITES is refused. The
   * reason is not tidiness: accepting a quote records a date and a name as evidence
   * that the client agreed, and a staff member able to click that button can
   * manufacture that evidence. Same for paying, and for editing the details the
   * client maintains. A preview that can act is not a preview.
   */
  preview: boolean;
}

/**
 * Who is this request, if anyone. Re-reads the user, the client and the business
 * every time: a token proves who signed in, not that they are still allowed in.
 */
export async function portalContext(token: string | undefined): Promise<PortalContext | null> {
  if (!token) return null;
  const payload = verifyPortalToken(token);
  if (!payload) return null;

  // A preview carries no portal user, on purpose: the point is to see what a client
  // WOULD see, including one who has never been given a login.
  const preview = payload.prv === 1;
  let user: typeof portalUsers.$inferSelect;
  if (preview) {
    user = {
      id: 0, accountId: payload.aid, businessId: payload.bid, folderId: payload.fid,
      email: '', name: 'Preview', passwordHash: null, isActive: true,
      lastLoginAt: null, failedAttempts: 0, lockedUntil: null, lastLinkAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
  } else {
    const [row] = await db.select().from(portalUsers)
      .where(eq(portalUsers.id, payload.pid)).limit(1);
    if (!row || !row.isActive) return null;
    // The token could be older than a change to the user's client. Trust the row.
    if (row.accountId !== payload.aid) return null;
    user = row;
  }

  const [client] = await db.select().from(folders)
    .where(and(eq(folders.id, user.folderId), eq(folders.accountId, user.accountId))).limit(1);
  if (!client || client.isArchived) return null;

  const [business] = await db.select().from(businesses)
    .where(and(eq(businesses.id, user.businessId), eq(businesses.accountId, user.accountId))).limit(1);
  if (!business) return null;

  return { user, client, business, preview };
}

/**
 * Issue a sign-in link. Returns the raw token, which is sent by email and never
 * stored, or null when there is nobody to send it to.
 *
 * Callers must not vary their response on null. That is the whole point.
 */
export async function issueLoginToken(email: string): Promise<{ raw: string; user: typeof portalUsers.$inferSelect } | null> {
  const [user] = await db.select().from(portalUsers)
    .where(and(eq(portalUsers.email, normaliseEmail(email)), eq(portalUsers.isActive, true)))
    .limit(1);
  if (!user) return null;

  // Throttle. Without this the endpoint is a way to fill a client's inbox, or to
  // push a shared-hosting mail queue over its limit, at one request per keystroke.
  // The caller still answers the same either way, so this leaks nothing.
  if (user.lastLinkAt && Date.now() - user.lastLinkAt.getTime() < LINK_MIN_GAP_SECONDS * 1000) {
    return null;
  }

  // Retire this person's outstanding links first, so asking for a second link
  // invalidates the first. Otherwise every request piles up another working key.
  await db.update(portalLoginTokens).set({ usedAt: new Date() })
    .where(and(eq(portalLoginTokens.portalUserId, user.id), isNull(portalLoginTokens.usedAt)));

  const raw = randomBytes(32).toString('base64url');
  await db.insert(portalLoginTokens).values({
    portalUserId: user.id,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + LINK_TTL_MINUTES * 60000),
  });
  await db.update(portalUsers).set({ lastLinkAt: new Date() }).where(eq(portalUsers.id, user.id));
  return { raw, user };
}

/** Spend a sign-in link. Single use: the second attempt with the same link fails. */
export async function consumeLoginToken(raw: string): Promise<typeof portalUsers.$inferSelect | null> {
  if (!raw) return null;
  const [row] = await db.select().from(portalLoginTokens)
    .where(and(
      eq(portalLoginTokens.tokenHash, hashToken(raw)),
      isNull(portalLoginTokens.usedAt),
      gt(portalLoginTokens.expiresAt, new Date()),
    )).limit(1);
  if (!row) return null;

  // Marking it used is the claim, and it is conditional on still being unused, so
  // two clicks arriving together cannot both succeed.
  const res = await db.update(portalLoginTokens).set({ usedAt: new Date() })
    .where(and(eq(portalLoginTokens.id, row.id), isNull(portalLoginTokens.usedAt)));
  if (!res[0].affectedRows) return null;

  const [user] = await db.select().from(portalUsers)
    .where(and(eq(portalUsers.id, row.portalUserId), eq(portalUsers.isActive, true))).limit(1);
  if (!user) return null;
  await db.update(portalUsers)
    .set({ lastLoginAt: new Date(), failedAttempts: 0, lockedUntil: null })
    .where(eq(portalUsers.id, user.id));
  return user;
}

/**
 * Sign in with a password, for people who set one.
 *
 * A missing user and a wrong password take the same path and the same time, so the
 * response cannot be used to work out which addresses exist.
 */
export async function passwordLogin(email: string, password: string): Promise<typeof portalUsers.$inferSelect | null> {
  const [user] = await db.select().from(portalUsers)
    .where(and(eq(portalUsers.email, normaliseEmail(email)), eq(portalUsers.isActive, true)))
    .limit(1);

  // Locked out: refuse without even comparing, but say nothing different to the
  // caller, so the lockout itself is not a signal that the address is real.
  if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) return null;

  // Always run a comparison, even with nobody to compare against, so the timing of
  // a miss matches the timing of a wrong password.
  const hash = user?.passwordHash ?? '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = await verifyPassword(password, hash).catch(() => false);

  if (!user || !user.passwordHash || !ok) {
    if (user) {
      const attempts = user.failedAttempts + 1;
      await db.update(portalUsers).set({
        failedAttempts: attempts,
        lockedUntil: attempts >= PORTAL_MAX_ATTEMPTS
          ? new Date(Date.now() + PORTAL_LOCKOUT_SECONDS * 1000) : null,
      }).where(eq(portalUsers.id, user.id));
    }
    return null;
  }

  await db.update(portalUsers)
    .set({ lastLoginAt: new Date(), failedAttempts: 0, lockedUntil: null })
    .where(eq(portalUsers.id, user.id));
  return user;
}

export async function setPortalPassword(portalUserId: number, password: string): Promise<void> {
  await db.update(portalUsers).set({ passwordHash: await hashPassword(password) })
    .where(eq(portalUsers.id, portalUserId));
}

export async function clearPortalPassword(portalUserId: number): Promise<void> {
  await db.update(portalUsers).set({ passwordHash: null }).where(eq(portalUsers.id, portalUserId));
}

/**
 * Make sure this client can sign in, without disturbing anyone who already can.
 *
 * Used when Klippy needs to ask a paying customer something. Someone who has just
 * bought hosting needs the portal regardless, and emailing them a link that lands
 * on a sign-in wall they have no account for is the same as not emailing them.
 */
export async function ensurePortalUser(
  accountId: number, businessId: number | null, folderId: number, email: string,
): Promise<void> {
  if (!businessId) return;
  const address = normaliseEmail(email);
  const [existing] = await db.select({ id: portalUsers.id }).from(portalUsers)
    .where(and(eq(portalUsers.folderId, folderId), eq(portalUsers.email, address))).limit(1);
  if (existing) return;
  await db.insert(portalUsers).values({ accountId, businessId, folderId, email: address })
    .catch(() => { /* a concurrent insert already did it */ });
}

/** Housekeeping: drop spent and expired links so the table does not grow forever. */
export async function pruneLoginTokens(): Promise<void> {
  await db.delete(portalLoginTokens)
    .where(lt(portalLoginTokens.expiresAt, new Date(Date.now() - 7 * 86400000)));
}

/** Constant-time compare for anything else that needs it. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
