import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';

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
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const isOwner = user?.role === 'owner'; // Only owners can delete the workspace

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
    <div className="space-y-8">
      <form onSubmit={save} className="space-y-4">
        {!isAdmin && <p className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">Only account admins can change these settings.</p>}
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">Account name</label>
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
            <button type="submit" disabled={busy} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
              {busy ? 'Saving...' : 'Save changes'}
            </button>
            {saved && <span className="text-sm text-green-400">Saved</span>}
          </div>
        )}
      </form>

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
    const confirmed = window.confirm(
      "Are you absolutely sure? This will permanently delete this account, including all businesses, boards, tasks, and files. This action CANNOT be undone."
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
        alert(data.error || 'Failed to delete workspace.');
        setIsDeleting(false);
      }
    } catch (error) {
      console.error("Error deleting workspace:", error);
      alert('An unexpected error occurred.');
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