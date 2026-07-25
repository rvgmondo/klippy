import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pushSubscriptions } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { pushEnabled, vapidPublicKey, sendPushToUser } from '../lib/push.js';
export async function pushRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // The browser needs the public VAPID key to subscribe.
    app.get('/api/v1/push/key', async () => {
        return { enabled: pushEnabled(), publicKey: vapidPublicKey() };
    });
    app.post('/api/v1/push/subscribe', async (req, reply) => {
        const { userId } = authOf(req);
        if (!pushEnabled())
            return reply.code(503).send({ error: 'Push is not configured on this server.' });
        const parsed = z.object({
            endpoint: z.string().url().max(500),
            keys: z.object({ p256dh: z.string().max(255), auth: z.string().max(255) }),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Invalid subscription.' });
        const { endpoint, keys } = parsed.data;
        const [existing] = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
            .where(eq(pushSubscriptions.endpoint, endpoint)).limit(1);
        if (existing) {
            await db.update(pushSubscriptions).set({ userId, p256dh: keys.p256dh, auth: keys.auth })
                .where(eq(pushSubscriptions.id, existing.id));
        }
        else {
            await db.insert(pushSubscriptions).values({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth });
        }
        return { ok: true };
    });
    app.post('/api/v1/push/unsubscribe', async (req, reply) => {
        const { userId } = authOf(req);
        const parsed = z.object({ endpoint: z.string().max(500) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'endpoint required.' });
        await db.delete(pushSubscriptions)
            .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, parsed.data.endpoint)));
        return { ok: true };
    });
    // Send yourself a test notification, to confirm the whole chain works.
    app.post('/api/v1/push/test', async (req, reply) => {
        const { userId } = authOf(req);
        if (!pushEnabled())
            return reply.code(503).send({ error: 'Push is not configured on this server.' });
        await sendPushToUser(userId, {
            title: 'Klippy',
            body: 'Push notifications are working.',
            url: '/',
            tag: 'klippy-test',
        });
        return { ok: true };
    });
}
//# sourceMappingURL=push.js.map