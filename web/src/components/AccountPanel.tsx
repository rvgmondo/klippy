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
          {isOwner && <RestoreBackup />}
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

/**
 * Reading a backup back in.
 *
 * Owner only, and it refuses rather than merges: it will only fill a workspace that
 * is still empty. That is not a limitation to apologise for, it is the whole safety
 * of the thing, so the copy says it up front rather than letting somebody discover
 * it from a 409. The report afterwards is not decoration either: it is where the
 * two things a person has to act on appear, namely hosting that needs checking
 * against the real server, and work that could not be matched to a person.
 */
export function RestoreBackup() {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ notes?: string[]; counts?: Record<string, number>; reattributed?: number } | null>(null);

  const pick = async (file: File) => {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      notify('That file is not readable as a Klippy backup.', 'error');
      return;
    }
    const okToRun = await confirmDialog(
      'Restore this backup into this workspace? It only works while the workspace is still empty, and it cannot be undone. Auto-debit stays switched off and hosting comes back as records you have to check.',
      { confirmLabel: 'Restore', danger: true },
    );
    if (!okToRun) return;
    setBusy(true); setReport(null);
    try {
      const res = await fetch('/api/v1/account/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      const body = await res.json();
      if (!res.ok) { notify(body.error ?? 'The restore did not run.', 'error'); return; }
      setReport(body);
      notify('Restored. Reload to see everything.', 'ok');
    } catch {
      notify('The restore did not run.', 'error');
    } finally { setBusy(false); }
  };

  const restoredRows = report?.counts
    ? Object.values(report.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="mt-4 border-t border-slate-800 pt-4">
      <h4 className="mb-1 text-sm font-semibold text-slate-200">Restore a backup</h4>
      <p className="mb-3 text-xs text-slate-500">
        Reads one of those files back in. It can only fill a workspace that is still
        empty, so if this one already has your work in it, make a new workspace and
        restore into that. Card debits stay switched off and hosting comes back as
        records to check, never as instructions to your server.
      </p>
      <label className={`inline-block cursor-pointer rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 ${busy ? 'opacity-50' : ''}`}>
        {busy ? 'Restoring...' : 'Choose a backup file'}
        <input type="file" accept="application/json,.json" className="hidden" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f); }} />
      </label>
      {report && (
        <div className="mt-3 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-quiet)] p-3 text-xs text-slate-200">
          <p className="font-medium">Restored {restoredRows} records.</p>
          {(report.notes ?? []).map((n, i) => (
            <p key={i} className="mt-1.5 text-slate-300">{n}</p>
          ))}
          <button onClick={() => window.location.reload()}
            className="mt-2 rounded-lg border border-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10">
            Reload
          </button>
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