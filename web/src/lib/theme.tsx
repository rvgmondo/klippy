import { useEffect } from 'react';
import { useAuth } from './auth';

export type Theme = 'system' | 'dark' | 'light';
export const ACCENTS = ['violet', 'blue', 'emerald', 'rose', 'amber', 'slate'] as const;
export type Accent = (typeof ACCENTS)[number];

const STORAGE_KEY = 'klippy-appearance';

/** What we last knew, so the very first paint isn't the wrong colour. */
export function readCachedAppearance(): { theme: Theme; accent: Accent } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { theme: 'dark', accent: 'violet' };
}

function resolve(theme: Theme): 'dark' | 'light' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyAppearance(theme: Theme, accent: Accent) {
  const root = document.documentElement;
  root.dataset.theme = resolve(theme);
  root.dataset.accent = accent;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, accent })); } catch { /* ignore */ }
}

/**
 * Keeps the DOM in sync with the signed-in person's saved appearance, and
 * follows the OS when they picked "system".
 */
export function ThemeSync() {
  const { user } = useAuth();
  const theme = (user?.theme ?? readCachedAppearance().theme) as Theme;
  const accent = (user?.accent ?? readCachedAppearance().accent) as Accent;

  useEffect(() => { applyAppearance(theme, accent); }, [theme, accent]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyAppearance('system', accent);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, accent]);

  return null;
}
