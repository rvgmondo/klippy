import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A small, dependency-free rate limiter for the sensitive front doors.
 *
 * Deliberately not @fastify/rate-limit: adding a dependency means the cPanel deploy
 * has to `npm install` it, and this is a handful of lines we fully control. It is an
 * in-memory sliding window keyed however the caller chooses (usually client IP).
 *
 * What it defends, per the security survey:
 *  - password spraying (one password across many emails from one source), which the
 *    per-user lockout does nothing about because each email is tried once;
 *  - an unauthenticated bcrypt-CPU DoS, where a few hundred login POSTs with any
 *    password saturate the event loop hashing them.
 *
 * Scope and honesty: Passenger runs several workers, so the window is per worker,
 * which softens rather than eliminates a distributed attack. It is a large, cheap
 * improvement over "no limit at all", not a WAF. Applied only to auth/portal-auth
 * endpoints so ordinary app traffic is never throttled.
 */
interface Bucket { count: number; resetAt: number }
const store = new Map<string, Bucket>();

// Prune expired buckets so the map cannot grow without bound under a spray of
// unique IPs. Unref so this timer never keeps the process alive on its own.
const CLEANUP_MS = 60_000;
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of store) if (b.resetAt <= now) store.delete(k);
}, CLEANUP_MS);
if (typeof cleanup.unref === 'function') cleanup.unref();

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed in the window before 429s. */
  max: number;
  /** How to bucket a request. Defaults to client IP. Prefix to avoid cross-route sharing. */
  key?: (req: FastifyRequest) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  const keyOf = opts.key ?? ((req: FastifyRequest) => req.ip);
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const k = keyOf(req);
    const now = Date.now();
    let b = store.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      store.set(k, b);
    }
    b.count += 1;
    if (b.count > opts.max) {
      const retry = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      reply.header('Retry-After', String(retry));
      await reply.code(429).send({ error: 'Too many attempts. Please wait a moment and try again.' });
    }
  };
}

/**
 * The standard limiter for auth front doors: 10 attempts per 5 minutes per IP.
 *
 * The cap is configurable ONLY so an end-to-end run can raise it. Seven suites signing
 * in one after another legitimately exceed ten attempts in five minutes, which made a
 * batch run fail on the rate limiter rather than on anything under test, and a test
 * that fails for the wrong reason trains people to ignore it.
 *
 * Production never sets AUTH_RATE_LIMIT_MAX, so production keeps ten. It is read once
 * at startup and clamped, so a typo cannot switch the limiter off: the floor is 5,
 * which is still a real limit, and a non-numeric value falls back to the default.
 */
const AUTH_MAX = (() => {
  const raw = Number(process.env.AUTH_RATE_LIMIT_MAX);
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  return Math.min(1000, Math.max(5, Math.round(raw)));
})();

export const authLimiter = (prefix: string) =>
  rateLimit({ windowMs: 5 * 60_000, max: AUTH_MAX, key: (req) => `${prefix}:${req.ip}` });
