const store = new Map();
// Prune expired buckets so the map cannot grow without bound under a spray of
// unique IPs. Unref so this timer never keeps the process alive on its own.
const CLEANUP_MS = 60_000;
const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of store)
        if (b.resetAt <= now)
            store.delete(k);
}, CLEANUP_MS);
if (typeof cleanup.unref === 'function')
    cleanup.unref();
export function rateLimit(opts) {
    const keyOf = opts.key ?? ((req) => req.ip);
    return async (req, reply) => {
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
    if (!Number.isFinite(raw) || raw <= 0)
        return 10;
    return Math.min(1000, Math.max(5, Math.round(raw)));
})();
export const authLimiter = (prefix) => rateLimit({ windowMs: 5 * 60_000, max: AUTH_MAX, key: (req) => `${prefix}:${req.ip}` });
//# sourceMappingURL=rateLimit.js.map