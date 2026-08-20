/**
 * The PWA install prompt, caught and held for the moment someone actually asks.
 *
 * Browsers fire `beforeinstallprompt` once, early, on their own schedule; if
 * nothing catches it the moment passes and "install the app" is impossible from
 * inside the page. Catch it at module load, and Settings offers a real button.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
  listeners.forEach((l) => l());
});

export function canInstall(): boolean {
  return deferred !== null;
}

export function onInstallable(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const ev = deferred;
  deferred = null;
  await ev.prompt();
  const choice = await ev.userChoice;
  return choice.outcome;
}
