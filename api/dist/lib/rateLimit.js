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
/** The standard limiter for auth front doors: 10 attempts per 5 minutes per IP. */
export const authLimiter = (prefix) => rateLimit({ windowMs: 5 * 60_000, max: 10, key: (req) => `${prefix}:${req.ip}` });
//# sourceMappingURL=rateLimit.js.map