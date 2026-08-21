import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, memberships } from '../db/schema.js';
import { withTenant } from './tenant.js';
import { notify as pushNotify } from './push.js';

/**
 * One door for "something happened that a human should hear about".
 *
 * Writes a row per recipient into the notifications inbox (the reliable part)
 * and fires a web push at each of them (the immediate part). Push is best
 * effort and per-device; the row is what guarantees the event is still there
 * in the morning. Never throws: a notification must not be able to break the
 * thing it is notifying about.
 */
export interface AppNotification {
  kind: string;
  title: string;
  body?: string;
  /** Same-app link, e.g. "/?v=pipeline", so clicking lands on the thing itself. */
  url?: string;
}

export async function notifyUsers(accountId: number, userIds: number[], n: AppNotification): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  try {
    await db.insert(notifications).values(ids.map((userId) => withTenant(accountId, {
      userId, kind: n.kind, title: n.title.slice(0, 200),
      body: n.body?.slice(0, 500) ?? null, url: n.url ?? null,
    })));
    for (const uid of ids) {
      pushNotify(uid, { title: n.title, body: n.body ?? '', url: n.url, tag: n.kind });
    }
  } catch {
    // Swallowed on purpose; see docblock.
  }
}

/** Money and leads concern whoever runs the place: every active owner and admin. */
export async function notifyAdmins(accountId: number, n: AppNotification): Promise<void> {
  try {
    const rows = await db.select({ userId: memberships.userId }).from(memberships)
      .where(and(
        eq(memberships.accountId, accountId),
        eq(memberships.isActive, true),
        inArray(memberships.role, ['owner', 'admin']),
      ));
    await notifyUsers(accountId, rows.map((r) => r.userId), n);
  } catch {
    // Swallowed on purpose; see docblock.
  }
}
