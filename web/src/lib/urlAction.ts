import { useEffect, useRef } from 'react';

/**
 * One-shot actions carried in the URL, so any screen can hand another screen an
 * intent ("open a new invoice for client 12") without threading callbacks through
 * the whole tree. The command palette and the client action row both speak this.
 *
 * A param is consumed exactly once: read, stripped from the URL, then acted on, so
 * a reload or a later visit to the same view does not replay it.
 */
const EVENT = 'klippy:params';

export function setUrlParams(params: Record<string, string>): void {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
  // Views already mounted re-check on this event; views that mount later check on
  // mount. Both paths go through the same consume-once read.
  window.dispatchEvent(new Event(EVENT));
}

/** Read AND strip one param, so it cannot fire twice. Null when absent. */
export function takeUrlParam(key: string): string | null {
  const q = new URLSearchParams(window.location.search);
  const v = q.get(key);
  if (v === null) return null;
  q.delete(key);
  window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
  return v;
}

/** Run `handler` whenever the named param appears, consuming it. */
export function useUrlAction(key: string, handler: (value: string) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const check = () => {
      const v = takeUrlParam(key);
      if (v !== null) ref.current(v);
    };
    check();
    window.addEventListener(EVENT, check);
    return () => window.removeEventListener(EVENT, check);
  }, [key]);
}
