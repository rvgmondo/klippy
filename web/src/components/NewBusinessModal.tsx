import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { BusinessType } from '../lib/types';

const TYPES: { value: BusinessType; label: string; desc: string }[] = [
  { value: 'services', label: 'Services', desc: 'Clients, projects, hourly billing' },
  { value: 'products', label: 'Products', desc: 'Orders, stock, cost & resale price' },
  { value: 'code', label: 'Code', desc: 'Customers, onboarding, subscriptions' },
  { value: 'content', label: 'Content', desc: 'Pieces, production, sponsors & ads' },
];

// Shown when creating a business: pick a name and a type. The type drives which example
// content gets seeded (Acquisition/Delivery/Operations stay the same three pillars either
// way - only the starter folder, board and deal are shaped for what you actually do).
export function NewBusinessModal({ onClose, onCreate, isPending }: {
  onClose: () => void;
  onCreate: (name: string, type: BusinessType) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<BusinessType>('services');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isPending) return;
    onCreate(name.trim(), type);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">New business</h2>
          <button type="button" onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <label className="mb-1 block text-xs text-slate-400">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Consulting"
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />

        <label className="mb-2 block text-xs text-slate-400">What kind of business is this?</label>
        <div className="mb-5 grid grid-cols-2 gap-2">
          {TYPES.map((t) => (
            <button type="button" key={t.value} onClick={() => setType(t.value)}
              className={`rounded-lg border p-3 text-left ${type === t.value ? 'border-violet-500 bg-violet-500/10' : 'border-slate-700 hover:border-slate-600'}`}>
              <div className="text-sm font-medium text-slate-100">{t.label}</div>
              <div className="mt-0.5 text-[11px] text-slate-400">{t.desc}</div>
            </button>
          ))}
        </div>

        <button type="submit" disabled={!name.trim() || isPending}
          className="w-full rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {isPending ? 'Creating...' : 'Create business'}
        </button>
      </form>
    </div>
  );
}
