import { useState } from 'react';
import { Monitor, Moon, Sun, Check } from 'lucide-react';
import { apiPatch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ACCENTS, applyAppearance, type Accent, type Theme } from '../lib/theme';

const SWATCH: Record<Accent, string> = {
  violet: '#8b5cf6', blue: '#3b82f6', emerald: '#10b981',
  rose: '#f43f5e', amber: '#f59e0b', slate: '#64748b',
};

const MODES: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <Sun size={15} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={15} /> },
  { value: 'system', label: 'System', icon: <Monitor size={15} /> },
];

export function AppearancePanel() {
  const { user, refresh } = useAuth();
  const [theme, setTheme] = useState<Theme>((user?.theme as Theme) ?? 'dark');
  const [accent, setAccent] = useState<Accent>((user?.accent as Accent) ?? 'violet');
  const [error, setError] = useState<string | null>(null);

  async function save(next: { theme?: Theme; accent?: Accent }) {
    const t = next.theme ?? theme;
    const a = next.accent ?? accent;
    setTheme(t); setAccent(a);
    applyAppearance(t, a);              // instant feedback, no waiting on the server
    try {
      await apiPatch('/profile', next);
      await refresh();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-slate-500">
        This is your personal preference. It follows your login into every workspace and
        does not affect anyone else.
      </p>

      <div>
        <label className="mb-2 block text-xs font-medium text-slate-400">Appearance</label>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button key={m.value} onClick={() => save({ theme: m.value })}
              className={`flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-xs ${
                theme === m.value
                  ? 'border-violet-500 bg-violet-600/10 text-violet-300'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}>
              {m.icon} {m.label}
            </button>
          ))}
        </div>
        {theme === 'system' && (
          <p className="mt-2 text-[11px] text-slate-500">Follows your device's light/dark setting automatically.</p>
        )}
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-slate-400">Accent colour</label>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((a) => (
            <button key={a} onClick={() => save({ accent: a })} title={a}
              className={`grid h-9 w-9 place-items-center rounded-full border-2 ${
                accent === a ? 'border-slate-100' : 'border-transparent'}`}
              style={{ background: SWATCH[a] }}>
              {accent === a && <Check size={15} className="text-white" />}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
    </div>
  );
}
