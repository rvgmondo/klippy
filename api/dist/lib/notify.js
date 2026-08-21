import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, memberships } from '../db/schema.js';
import { withTenant } from './tenant.js';
import { notify as pushNotify } from './push.js';
export async function notifyUsers(accountId, userIds, n) {
    const ids = [...new Set(userIds)];
    if (!ids.length)
        return;
    try {
        await db.insert(notifications).values(ids.map((userId) => withTenant(accountId, {
            userId, kind: n.kind, title: n.title.slice(0, 200),
            body: n.body?.slice(0, 500) ?? null, url: n.url ?? null,
        })));
        for (const uid of ids) {
            pushNotify(uid, { title: n.title, body: n.body ?? '', url: n.url, tag: n.kind });
        }
    }
    catch {
        // Swallowed on purpose; see docblock.
    }
}
/** Money and leads concern whoever runs the place: every active owner and admin. */
export async function notifyAdmins(accountId, n) {
    try {
        const rows = await db.select({ userId: memberships.userId }).from(memberships)
            .where(and(eq(memberships.accountId, accountId), eq(memberships.isActive, true), inArray(memberships.role, ['owner', 'admin'])));
        await notifyUsers(accountId, rows.map((r) => r.userId), n);
    }
    catch {
        // Swallowed on purpose; see docblock.
    }
}
//# sourceMappingURL=notify.js.map