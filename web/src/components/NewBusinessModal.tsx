import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { apiGet } from '../lib/api';

interface Blueprint { key: string; label: string; type: string; blurb: string }

/**
 * Creating a business is a single question: what kind is it.
 *
 * The answer is a blueprint, which decides the starter content, which modules the
 * sidebar shows, and how it bills and chases. Picking "Hosting" gets a business
 * that renews annually, chases hard and has no timesheet, without anyone having to
 * find those settings afterwards.
 */
export function NewBusinessModal({ onClose, onCreate, isPending }: {
  onClose: () => void;
  onCreate: (name: string, blueprintKey: string) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState('agency');
  const { data } = useQuery({
    queryKey: ['blueprints'],
    queryFn: () => apiGet<{ blueprints: Blueprint[] }>('/blueprints'),
    staleTime: 60 * 60 * 1000,
  });
  const blueprints = data?.blueprints ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isPending) return;
    onCreate(name.trim(), chosen);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">New business</h2>
          <button type="button" onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <label className="mb-1 block text-xs text-slate-400">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Consulting"
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-[var(--accent)]" />

        <label className="mb-2 block text-xs text-slate-400">What kind of business is this?</label>
        <div className="mb-5 space-y-2">
          {blueprints.map((b) => (
            <button type="button" key={b.key} onClick={() => setChosen(b.key)}
              className={`w-full rounded-lg border p-3 text-left transition ${
                chosen === b.key ? 'border-[var(--accent)] bg-[var(--accent-quiet)]' : 'border-slate-700 hover:border-slate-600'}`}>
              <div className="text-sm font-medium text-slate-100">{b.label}</div>
              <div className="mt-0.5 text-[11px] text-slate-400">{b.blurb}</div>
            </button>
          ))}
        </div>

        <p className="mb-4 text-[11px] text-slate-500">
          This sets up the starter boards, which sections show in the sidebar, and how invoices are
          chased. All of it can be changed later in Settings.
        </p>

        <button type="submit" disabled={!name.trim() || isPending}
          className="w-full rounded-lg bg-[var(--accent)] py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50">
          {isPending ? 'Creating...' : 'Create business'}
        </button>
      </form>
    </div>
  );
}
