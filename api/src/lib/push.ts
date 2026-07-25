import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pushSubscriptions } from '../db/schema.js';

/**
 * Web push. VAPID keys come from the environment; if they are not set, push is
 * simply off (subscribe endpoints will say so) rather than crashing the app.
 * Generate a keypair once with:  npx web-push generate-vapid-keys
 */
let configured = false;
export function pushEnabled(): boolean {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@localhost', pub, priv);
  configured = true;
  return true;
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

interface PushPayload { title: string; body: string; url?: string; tag?: string }

/** Send a notification to every device a user has registered. Prunes dead ones. */
export async function sendPushToUser(userId: number, payload: PushPayload): Promise<void> {
  if (!pushEnabled()) return;
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (!subs.length) return;

  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      );
    } catch (err: unknown) {
      // 404/410 means the browser dropped the subscription; delete it.
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)).catch(() => {});
      }
    }
  }));
}

/** Fire-and-forget so a notification failure never blocks the user's action. */
export function notify(userId: number, payload: PushPayload): void {
  void sendPushToUser(userId, payload).catch(() => {});
}
