import { useState, type FormEvent } from 'react';
import { confirmDialog, notify } from './ConfirmDialog';
import { useAuth } from '../lib/auth';
import { useCurrencyOptions } from '../lib/useCurrency';
import { fieldClass } from './ui';

/**
 * The account everyone in it shares: its name, what top-level folders are called,
 * and (for the owner) deleting the whole thing. Anything a CLIENT sees lives per
 * business instead, so several companies can run under one login.
 */
export function AccountPanel() {
  const { account, user, updateAccount } = useAuth();
  const [name, setName] = useState(account?.name ?? '');
  const [singular, setSingular] = useState(account?.folderLabelSingular ?? 'Client');
  const [plural, setPlural] = useState(account?.folderLabelPlural ?? 'Clients');
  const [currency, setCurrency] = useState(account?.currency ?? 'ZAR');
  const currencies = useCurrencyOptions();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const isOwner = user?.role === 'owner'; // Only owners can delete the workspace

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setSaved(false); setBusy(true);
    try {
      await updateAccount({
        name: name.trim(), folderLabelSingular: singular.trim(), folderLabelPlural: plural.trim(),
        currency,
      });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally { setBusy(false); }
  }

  const field = fieldClass;

  return (
    <div className="space-y-8">
      <form onSubmit={save} className="space-y-4">
        {!isAdmin && <p className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">Only account admins can change these settings.</p>}
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
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">Currency</label>
          <select className={field} value={currency} disabled={!isAdmin}
            onChange={(e) => setCurrency(e.target.value)}>
            {(currencies.length ? currencies : [{ code: currency, name: currency, symbol: '', decimals: 2 }])
              .map((c) => <option key={c.code} value={c.code}>{c.code} - {c.name}</option>)}
          </select>
          <p className="mt-1 text-[11px] text-slate-500">
            What this workspace bills in by default. Each business can override it under
            Business settings, which is how one account runs a rand company and a dollar
            company side by side. Documents already issued keep the currency they were
            raised in and are never restated.
          </p>
        </div>
        {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        {isAdmin && (
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
              {busy ? 'Saving...' : 'Save changes'}
            </button>
            {saved && <span className="text-sm text-green-400">Saved</span>}
          </div>
        )}
      </form>

      {isAdmin && (
        <div className="border-t border-slate-800 pt-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-200">Your data</h3>
          <p className="mb-3 text-xs text-slate-500">
            This workspace as one JSON file: clients, boards, cards with their subtasks,
            comments and labels, time, files, the calendar, contacts, deals, documents,
            payments, offerings, subscriptions, hosting and expenses. No passwords or
            payment credentials are included. Keep a copy somewhere that is not this
            server.
          </p>
          <a href="/api/v1/account/export" download
            className="inline-block rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">
            Download everything (JSON)
          </a>
        </div>
      )}

      {/* Render the delete button for owners only */}
      {isOwner && account?.id && (
        <div className="pt-4 border-t border-slate-800">
          <DeleteWorkspaceButton workspaceId={account.id} />
        </div>
      )}
    </div>
  );
}

export function DeleteWorkspaceButton({ workspaceId }: { workspaceId: number }) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    const confirmed = await confirmDialog(
      'Permanently delete this workspace, with every business, board, task and file in it? This cannot be undone.',
      { confirmLabel: 'Delete workspace', danger: true },
    );

    if (!confirmed) return;

    setIsDeleting(true);

    try {
      const response = await fetch(`/api/v1/workspaces/${workspaceId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        window.location.href = '/'; 
      } else {
        const data = await response.json();
        notify(data.error || 'Failed to delete workspace.', 'error');
        setIsDeleting(false);
      }
    } catch (error) {
      console.error("Error deleting workspace:", error);
      notify('An unexpected error occurred.', 'error');
      setIsDeleting(false);
    }
  };

  return (
    <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4">
      <h3 className="mb-1 text-sm font-semibold text-red-400">Danger Zone</h3>
      <p className="mb-4 text-xs text-red-300/70">
        Permanently delete this account and all of its data. This cannot be undone.
      </p>
      <button 
        onClick={handleDelete} 
        disabled={isDeleting}
        className="rounded-lg bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 border border-red-500/20 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
      >
        {isDeleting ? 'Deleting...' : 'Delete Account'}
      </button>
    </div>
  );
}