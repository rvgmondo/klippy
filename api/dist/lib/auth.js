import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
const SECRET = process.env.JWT_SECRET;
if (!SECRET)
    throw new Error('JWT_SECRET is not set (see api/.env.example).');
export const COOKIE_NAME = 'klippy_token';
const TOKEN_TTL = '7d';
export async function hashPassword(plain) {
    return bcrypt.hash(plain, 12);
}
export async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}
/**
 * Which kind of token this is. Staff tokens and client-portal tokens are signed
 * with the same secret, so without this a portal token verifies perfectly well as a
 * staff token: the claims it lacks (`uid`, `role`) simply read as undefined, and
 * the account id it does carry is real. That is a client holding staff access to
 * the whole workspace. The audience is what keeps the two apart.
 */
export const APP_AUDIENCE = 'klippy-app';
export function signToken(payload) {
    return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL, audience: APP_AUDIENCE });
}
/**
 * A short-lived ticket for the gap between a correct password and a correct
 * 2FA code. Its own audience, so it can never be presented as a session cookie,
 * and five minutes, so an abandoned login screen is not a standing invitation.
 */
export const TWOFA_AUDIENCE = 'klippy-2fa';
export function signTwoFactorTicket(payload) {
    return jwt.sign(payload, SECRET, { expiresIn: '5m', audience: TWOFA_AUDIENCE });
}
export function verifyTwoFactorTicket(ticket) {
    try {
        const p = jwt.verify(ticket, SECRET, { audience: TWOFA_AUDIENCE });
        if (typeof p?.uid !== 'number' || typeof p?.aid !== 'number')
            return null;
        return p;
    }
    catch {
        return null;
    }
}
export function verifyToken(token) {
    try {
        const p = jwt.verify(token, SECRET, { audience: APP_AUDIENCE });
        // Belt as well as braces: a token that verifies but names no user is not a
        // staff token whatever its audience says, and letting it through would hand
        // out an undefined userId with a real accountId beside it.
        if (typeof p?.uid !== 'number' || typeof p?.aid !== 'number')
            return null;
        return p;
    }
    catch {
        return null;
    }
}
/** Options for the auth cookie. Secure only in production (HTTPS). */
export function cookieOptions() {
    const isProd = process.env.NODE_ENV === 'production';
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        path: '/',
        maxAge: 60 * 60 * 24 * 7, // 7 days, seconds
        ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    };
}
/** Make a URL-safe slug from a name; caller ensures uniqueness. */
export function slugify(input) {
    const base = input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return base || 'workspace';
}
// Login lockout policy (mirrors the v1 PHP app).
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_SECONDS = 15 * 60;
//# sourceMappingURL=auth.js.map