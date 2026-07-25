import { apiGet, apiPost } from './api';

/** Web-push helpers for the browser side. */

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Ask permission, subscribe, and register with the server. Returns true on success. */
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: 'This browser does not support notifications.' };

  const cfg = await apiGet<{ enabled: boolean; publicKey: string | null }>('/push/key');
  if (!cfg.enabled || !cfg.publicKey) return { ok: false, error: 'Push is not switched on for this server yet.' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, error: 'Notifications were blocked. Enable them in your browser settings.' };

  const reg = await navigator.serviceWorker.ready;
  const key = urlBase64ToUint8Array(cfg.publicKey);
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // Copy into a fresh ArrayBuffer-backed view to satisfy the DOM type.
    applicationServerKey: key.buffer.slice(0) as ArrayBuffer,
  });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
  await apiPost('/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
  return { ok: true };
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await apiPost('/push/unsubscribe', { endpoint }).catch(() => {});
}

export async function sendTestPush(): Promise<void> {
  await apiPost('/push/test');
}
