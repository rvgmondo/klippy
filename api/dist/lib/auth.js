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
export function signToken(payload) {
    return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL });
}
export function verifyToken(token) {
    try {
        return jwt.verify(token, SECRET);
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