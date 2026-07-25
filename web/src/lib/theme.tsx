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
  // Logged-out pages (landing, login) always show the brand's dark/violet look,
  // regardless of a returning visitor's saved preference. Once signed in, the
  // person's own theme takes over.
  const theme = (user ? user.theme ?? readCachedAppearance().theme : 'dark') as Theme;
  const accent = (user ? user.accent ?? readCachedAppearance().accent : 'violet') as Accent;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme === 'system'
      ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;
    root.dataset.accent = accent;
    // Only remember the choice for a signed-in user.
    if (user) applyAppearance(theme, accent);
  }, [theme, accent, user]);

  useEffect(() => {
    if (theme !== 'system' || !user) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyAppearance('system', accent);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, accent, user]);

  return null;
}
