import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET is not set (see api/.env.example).');

export const COOKIE_NAME = 'klippy_token';
const TOKEN_TTL = '7d';

export interface TokenPayload {
  uid: number; // user id
  aid: number; // account id
  role: 'owner' | 'admin' | 'member';
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, SECRET as string, { expiresIn: TOKEN_TTL });
}
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, SECRET as string) as TokenPayload;
  } catch {
    return null;
  }
}

/** Options for the auth cookie. Secure only in production (HTTPS). */
export function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProd,
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days, seconds
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
}

/** Make a URL-safe slug from a name; caller ensures uniqueness. */
export function slugify(input: string): string {
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
