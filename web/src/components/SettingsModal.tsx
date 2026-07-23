import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { PeoplePanel } from './PeoplePanel';
import { LabelsPanel } from './LabelsPanel';

type Tab = 'workspace' | 'people' | 'labels';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('workspace');

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className="flex gap-1 border-b border-slate-800 px-4 pt-2">
          {(['workspace', 'people', 'labels'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`rounded-t-lg px-3 py-2 text-sm font-medium capitalize ${tab === t ? 'bg-slate-900 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {t}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'workspace' && <WorkspaceTab />}
          {tab === 'people' && <PeoplePanel />}
          {tab === 'labels' && <LabelsPanel />}
        </div>
      </div>
    </div>
  );
}

function WorkspaceTab() {
  const { account, user, updateAccount } = useAuth();
  const [name, setName] = useState(account?.name ?? '');
  const [singular, setSingular] = useState(account?.folderLabelSingular ?? 'Client');
  const [plural, setPlural] = useState(account?.folderLabelPlural ?? 'Clients');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setSaved(false); setBusy(true);
    try {
      await updateAccount({ name: name.trim(), folderLabelSingular: singular.trim(), folderLabelPlural: plural.trim() });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally { setBusy(false); }
  }

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500 disabled:opacity-50';

  return (
    <form onSubmit={save} className="space-y-4">
      {!isAdmin && <p className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">Only workspace admins can change these settings.</p>}
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">Workspace name</label>
        <input className={field} value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} placeholder="Mondobase" />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-slate-400">What do you call your top-level folders?</div>
        <p className="mb-2 text-[11px] text-slate-500">Rename "Clients" to whatever fits: Businesses, Customers, Projects. Shown in the sidebar.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">Singular</label>
            <input className={field} value={singular} disabled={!isAdmin} onChange={(e) => setSingular(e.target.value)} placeholder="Client" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">Plural</label>
            <input className={field} value={plural} disabled={!isAdmin} onChange={(e) => setPlural(e.target.value)} placeholder="Clients" />
          </div>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
      {isAdmin && (
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60">
            {busy ? 'Saving...' : 'Save changes'}
          </button>
          {saved && <span className="text-sm text-green-400">Saved</span>}
        </div>
      )}
    </form>
  );
}
