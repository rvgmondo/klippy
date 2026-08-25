import { useEffect, useState } from 'react';

/**
 * The page's motion contract, in one place.
 *
 * Reduced motion here is graceful degradation, not a kill switch, which is the
 * distinction the accessible-animation guidance turns on. Three tiers:
 *
 *   Tier 1, removed outright: parallax, long translates across the viewport,
 *     scale of large elements, the WebGL field, and Lenis itself (smooth scroll
 *     IS scroll hijacking, however gentle).
 *   Tier 2, softened: a 600ms rise becomes a 150ms cross-fade.
 *   Tier 3, kept always: opacity, colour and focus-ring transitions, because
 *     removing those costs feedback and buys nothing.
 *
 * The preference is read through matchMedia rather than CSS alone, because CSS
 * cannot stop a requestAnimationFrame loop or a GSAP timeline, and it is watched
 * for changes: switching the OS setting fires no reload, so a page that only
 * reads it once is wrong from that moment on.
 */
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCE_QUERY).matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia(REDUCE_QUERY);
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Whether this device can actually run the hero field. Probed with a throwaway
 * context rather than assumed: a browser can advertise the constructor and still
 * fail to give you a context on a blocklisted driver.
 */
export function hasWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
