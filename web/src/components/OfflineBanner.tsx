import { useEffect, useState } from 'react';

/**
 * Say when the connection is gone, instead of letting every action fail quietly.
 *
 * The installed shell loads offline, which used to mean a working-looking app
 * whose every button errored. A plain banner turns confusion into information,
 * and announces the state change to a screen reader.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  if (online) return null;
  return (
    <div role="status" aria-live="assertive"
      className="fixed inset-x-0 top-0 z-[130] bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-amber-950">
      You are offline. Changes cannot be saved until the connection is back.
    </div>
  );
}
