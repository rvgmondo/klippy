import { z } from 'zod';
import { and, desc, eq, isNull, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
/**
 * The notification inbox: what happened while you were not looking, per person.
 * Deliberately small: a list, an unread count, and a way to mark things read.
 */
export async function notificationRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/notifications', async (req) => {
        const { accountId, userId } = authOf(req);
        const items = await db.select({
            id: notifications.id, kind: notifications.kind, title: notifications.title,
            body: notifications.body, url: notifications.url, readAt: notifications.readAt,
            createdAt: notifications.createdAt,
        }).from(notifications)
            .where(tenantWhere(notifications, accountId, eq(notifications.userId, userId)))
            .orderBy(desc(notifications.id))
            .limit(30);
        const [row] = await db.select({ n: sql `COUNT(*)` }).from(notifications)
            .where(tenantWhere(notifications, accountId, eq(notifications.userId, userId), isNull(notifications.readAt)));
        return { items, unread: Number(row?.n ?? 0) };
    });
    app.post('/api/v1/notifications/read', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = z.object({
            ids: z.array(z.number().int().positive()).max(100).optional(),
            all: z.boolean().optional(),
        }).safeParse(req.body ?? {});
        if (!parsed.success || (!parsed.data.ids?.length && !parsed.data.all)) {
            return reply.code(400).send({ error: 'Pass ids or all.' });
        }
        await db.update(notifications).set({ readAt: new Date() })
            .where(and(tenantWhere(notifications, accountId, eq(notifications.userId, userId), isNull(notifications.readAt)), parsed.data.all ? undefined : inArray(notifications.id, parsed.data.ids)));
        return { ok: true };
    });
}
//# sourceMappingURL=notifications.js.map