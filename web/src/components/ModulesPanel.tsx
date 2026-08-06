import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../lib/api';
import type { Business } from '../lib/types';

interface ModuleDef { key: string; label: string; primitive: string; core: boolean; hint: string }
interface Catalogue {
  primitives: { key: string; label: string; blurb: string }[];
  modules: ModuleDef[];
}

/**
 * Which parts of Klippy this business uses.
 *
 * A shop has no use for timesheets and a copywriter has no use for stock levels, so
 * a business only carries the modules it needs. Defaults come from the business
 * type and are right for most people; this is the override when they are not.
 */
export function ModulesPanel({ business }: { business: Business }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['modules'],
    queryFn: () => apiGet<Catalogue>('/modules'),
    staleTime: 60 * 60 * 1000,
  });
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const current = new Set(chosen ?? business.modules ?? []);
  const save = useMutation({
    mutationFn: (mods: string[] | null) => apiPatch(`/businesses/${business.id}`, { modules: mods }),
    onSuccess: () => {
      setSaved(true); setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ['businesses'] });
    },
  });

  if (!data) return null;

  const toggle = (key: string) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    setChosen([...next]);
  };

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        Turn off what {business.name} does not use and it disappears from the sidebar. Some modules are
        always on, since Klippy stops being useful without them.
      </p>

      {data.primitives.map((p) => {
        const mods = data.modules.filter((m) => m.primitive === p.key);
        if (!mods.length) return null;
        return (
          <section key={p.key}>
            <div className="mb-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{p.label}</div>
              <div className="text-[10px] text-slate-600">{p.blurb}</div>
            </div>
            <div className="space-y-1.5">
              {mods.map((m) => (
                <label key={m.key}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${
                    m.core ? 'border-slate-800 bg-slate-900/20' : 'cursor-pointer border-slate-800 bg-slate-900/40 hover:border-slate-700'
                  }`}>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                    checked={m.core || current.has(m.key)} disabled={m.core}
                    onChange={() => toggle(m.key)} />
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200">
                      {m.label}
                      {m.core && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-600">always on</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">{m.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </section>
        );
      })}

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4">
        <button onClick={() => save.mutate([...current])} disabled={save.isPending}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-60">
          {save.isPending ? 'Saving...' : 'Save'}
        </button>
        <button onClick={() => { setChosen(null); save.mutate(null); }}
          className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">
          Reset to defaults for a {business.type} business
        </button>
        {saved && <span className="text-sm text-violet-300">Saved</span>}
        {save.error && <span className="text-sm text-red-400">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}
