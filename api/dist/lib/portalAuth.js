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
/**
 * A staff preview expires quickly. It is a look at someone else's account, so it
 * should not survive the sitting in which it was opened.
 */
const PREVIEW_TTL = '30m';
export function signPreviewToken(p) {
    return jwt.sign({ ...p, pid: 0, prv: 1 }, SECRET, { expiresIn: PREVIEW_TTL, audience: PORTAL_AUDIENCE });
}
export function signPortalToken(p) {
    return jwt.sign(p, SECRET, { expiresIn: TOKEN_TTL, audience: PORTAL_AUDIENCE });
}
export function verifyPortalToken(token) {
    try {
        return jwt.verify(token, SECRET, { audience: PORTAL_AUDIENCE });
    }
    catch {
        return null;
    }
}
export function portalCookieOptions() {
    const isProd = process.env.NODE_ENV === 'production';
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
        ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    };
}
const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');
/** Normalise the way an address is compared, so casing and stray spaces do not lock anyone out. */
export const normaliseEmail = (e) => e.trim().toLowerCase();
/**
 * Who is this request, if anyone. Re-reads the user, the client and the business
 * every time: a token proves who signed in, not that they are still allowed in.
 */
export async function portalContext(token) {
    if (!token)
        return null;
    const payload = verifyPortalToken(token);
    if (!payload)
        return null;
    // A preview carries no portal user, on purpose: the point is to see what a client
    // WOULD see, including one who has never been given a login.
    const preview = payload.prv === 1;
    let user;
    if (preview) {
        user = {
            id: 0, accountId: payload.aid, businessId: payload.bid, folderId: payload.fid,
            email: '', name: 'Preview', passwordHash: null, isActive: true,
            lastLoginAt: null, failedAttempts: 0, lockedUntil: null, lastLinkAt: null,
            createdAt: new Date(), updatedAt: new Date(),
        };
    }
    else {
        const [row] = await db.select().from(portalUsers)
            .where(eq(portalUsers.id, payload.pid)).limit(1);
        if (!row || !row.isActive)
            return null;
        // The token could be older than a change to the user's client. Trust the row.
        if (row.accountId !== payload.aid)
            return null;
        user = row;
    }
    const [client] = await db.select().from(folders)
        .where(and(eq(folders.id, user.folderId), eq(folders.accountId, user.accountId))).limit(1);
    if (!client || client.isArchived)
        return null;
    const [business] = await db.select().from(businesses)
        .where(and(eq(businesses.id, user.businessId), eq(businesses.accountId, user.accountId))).limit(1);
    if (!business)
        return null;
    return { user, client, business, preview };
}
/**
 * Issue a sign-in link for ONE specific portal user (a specific client of a
 * specific business), by id. This is the primitive every caller that already knows
 * which portal it means should use: staff inviting a client they just added, the
 * hosting flow emailing the client it just provisioned. Resolving by email instead
 * would re-pick an arbitrary row when the same address is a client of more than one
 * business, and land the recipient in the wrong company's portal.
 *
 * Returns the raw token, sent by email and never stored, or null when the user is
 * gone, switched off, or was emailed a link too recently.
 */
export async function issueLoginTokenForUser(portalUserId) {
    const [user] = await db.select().from(portalUsers)
        .where(and(eq(portalUsers.id, portalUserId), eq(portalUsers.isActive, true))).limit(1);
    if (!user)
        return null;
    // Throttle per portal user. Without this the link endpoint is a way to fill a
    // client's inbox, or push a shared-hosting mail queue over its limit, one request
    // per keystroke. The caller still answers the same either way, so this leaks nothing.
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
/**
 * Self-service by email: issue a link for EVERY portal that address legitimately
 * holds. When someone is a client of two businesses on Klippy under one address (a
 * bookkeeper who is the billing contact for several), email alone cannot say which
 * they mean, and picking one arbitrarily used to drop them into the wrong tenant's
 * portal. So each of their own doors gets its own link, every mail to the address
 * they already own, and they pick. An unknown address yields an empty list, and the
 * caller must answer the same either way so this never reveals who is on file.
 */
export async function issueLoginTokensForEmail(email) {
    const rows = await db.select({ id: portalUsers.id }).from(portalUsers)
        .where(and(eq(portalUsers.email, normaliseEmail(email)), eq(portalUsers.isActive, true)));
    const issued = [];
    for (const r of rows) {
        const one = await issueLoginTokenForUser(r.id);
        if (one)
            issued.push(one);
    }
    return issued;
}
/** Spend a sign-in link. Single use: the second attempt with the same link fails. */
export async function consumeLoginToken(raw) {
    if (!raw)
        return null;
    const [row] = await db.select().from(portalLoginTokens)
        .where(and(eq(portalLoginTokens.tokenHash, hashToken(raw)), isNull(portalLoginTokens.usedAt), gt(portalLoginTokens.expiresAt, new Date()))).limit(1);
    if (!row)
        return null;
    // Marking it used is the claim, and it is conditional on still being unused, so
    // two clicks arriving together cannot both succeed.
    const res = await db.update(portalLoginTokens).set({ usedAt: new Date() })
        .where(and(eq(portalLoginTokens.id, row.id), isNull(portalLoginTokens.usedAt)));
    if (!res[0].affectedRows)
        return null;
    const [user] = await db.select().from(portalUsers)
        .where(and(eq(portalUsers.id, row.portalUserId), eq(portalUsers.isActive, true))).limit(1);
    if (!user)
        return null;
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
export async function passwordLogin(email, password) {
    // One address can be a client of more than one business (unique key is folder +
    // email), so there may be several rows. A password can only ever verify against
    // its own bcrypt hash, so this cannot cross a tenant wall; picking `limit 1` blind
    // was a reliability hole, not a leak, wrongly rejecting a real login when it landed
    // on the sibling row. Authenticate against whichever row the password actually fits.
    const rows = await db.select().from(portalUsers)
        .where(and(eq(portalUsers.email, normaliseEmail(email)), eq(portalUsers.isActive, true)));
    const now = Date.now();
    let matched = null;
    let compared = false;
    for (const u of rows) {
        // A locked or password-less row is not a candidate, but a locked row must not
        // become a way to tell a real address from a fake one, so we simply skip it.
        if (u.lockedUntil && u.lockedUntil.getTime() > now)
            continue;
        if (!u.passwordHash)
            continue;
        compared = true;
        if (await verifyPassword(password, u.passwordHash).catch(() => false)) {
            matched = u;
            break;
        }
    }
    // Always run at least one comparison, even with nobody to compare against, so the
    // timing of a miss matches the timing of a wrong password and the endpoint cannot
    // be used to work out which addresses exist.
    if (!compared) {
        await verifyPassword(password, '$2a$12$0000000000000000000000000000000000000000000000000000').catch(() => false);
    }
    if (!matched) {
        // A failed attempt counts against every password-bearing row for this address,
        // so the lockout still bites a brute-forcer no matter which sibling they hit.
        for (const u of rows) {
            if (!u.passwordHash)
                continue;
            const attempts = u.failedAttempts + 1;
            await db.update(portalUsers).set({
                failedAttempts: attempts,
                lockedUntil: attempts >= PORTAL_MAX_ATTEMPTS
                    ? new Date(now + PORTAL_LOCKOUT_SECONDS * 1000) : null,
            }).where(eq(portalUsers.id, u.id));
        }
        return null;
    }
    await db.update(portalUsers)
        .set({ lastLoginAt: new Date(), failedAttempts: 0, lockedUntil: null })
        .where(eq(portalUsers.id, matched.id));
    return matched;
}
export async function setPortalPassword(portalUserId, password) {
    await db.update(portalUsers).set({ passwordHash: await hashPassword(password) })
        .where(eq(portalUsers.id, portalUserId));
}
export async function clearPortalPassword(portalUserId) {
    await db.update(portalUsers).set({ passwordHash: null }).where(eq(portalUsers.id, portalUserId));
}
/**
 * Make sure this client can sign in, without disturbing anyone who already can.
 *
 * Used when Klippy needs to ask a paying customer something. Someone who has just
 * bought hosting needs the portal regardless, and emailing them a link that lands
 * on a sign-in wall they have no account for is the same as not emailing them.
 */
export async function ensurePortalUser(accountId, businessId, folderId, email) {
    if (!businessId)
        return null;
    const address = normaliseEmail(email);
    const [existing] = await db.select({ id: portalUsers.id }).from(portalUsers)
        .where(and(eq(portalUsers.folderId, folderId), eq(portalUsers.email, address))).limit(1);
    if (existing)
        return existing.id;
    try {
        const ins = await db.insert(portalUsers).values({ accountId, businessId, folderId, email: address });
        return Number(ins[0].insertId);
    }
    catch {
        // A concurrent insert already made it; return that row so the caller can still
        // issue a link for exactly this portal rather than re-resolving by email.
        const [again] = await db.select({ id: portalUsers.id }).from(portalUsers)
            .where(and(eq(portalUsers.folderId, folderId), eq(portalUsers.email, address))).limit(1);
        return again?.id ?? null;
    }
}
/** Housekeeping: drop spent and expired links so the table does not grow forever. */
export async function pruneLoginTokens() {
    await db.delete(portalLoginTokens)
        .where(lt(portalLoginTokens.expiresAt, new Date(Date.now() - 7 * 86400000)));
}
/** Constant-time compare for anything else that needs it. */
export function safeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length)
        return false;
    return timingSafeEqual(ba, bb);
}
/**
 * A password a human can read down a phone line and type once: three short
 * lowercase words plus digits, no ambiguous characters, and long enough that
 * length rather than punctuation does the work.
 */
const PW_WORDS = [
    'amber', 'anchor', 'basil', 'bridge', 'cabin', 'cedar', 'cobalt', 'copper', 'coral', 'delta',
    'ember', 'fable', 'falcon', 'garden', 'harbor', 'indigo', 'ivory', 'jasper', 'kite', 'lantern',
    'maple', 'meadow', 'nectar', 'onyx', 'opal', 'pebble', 'quartz', 'raven', 'river', 'saffron',
    'summit', 'tandem', 'thistle', 'umber', 'valley', 'walnut', 'willow', 'yarrow', 'zephyr', 'zinc',
];
export function generatePortalPassword() {
    const bytes = randomBytes(8);
    const word = (i) => PW_WORDS[bytes[i] % PW_WORDS.length];
    const digits = String(100 + (bytes[3] % 900));
    return `${word(0)}-${word(1)}-${word(2)}-${digits}`;
}
//# sourceMappingURL=portalAuth.js.map