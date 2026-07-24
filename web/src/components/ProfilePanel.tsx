import { useState, type FormEvent } from 'react';
import { apiPatch } from '../lib/api';
import { useAuth } from '../lib/auth';

export function ProfilePanel() {
  const { user, account, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500';

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setMsg(null); setBusy(true);
    try {
      await apiPatch('/profile', { name: name.trim() });
      await refresh();
      setMsg({ kind: 'ok', text: 'Name updated.' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Could not save.' });
    } finally { setBusy(false); }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) { setMsg({ kind: 'err', text: 'The new passwords do not match.' }); return; }
    setBusy(true);
    try {
      await apiPatch('/profile', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setConfirm('');
      setMsg({ kind: 'ok', text: 'Password changed.' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Could not change password.' });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
        Signed in as <span className="text-slate-200">{user?.email}</span> ({user?.role}) in {account?.name}
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${msg.kind === 'ok'
          ? 'border-green-500/30 bg-green-500/10 text-green-300'
          : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>{msg.text}</div>
      )}

      <form onSubmit={saveName} className="space-y-2">
        <label className="block text-xs font-medium text-slate-400">Your name</label>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={busy || !name.trim()}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60">
          Save name
        </button>
      </form>

      <form onSubmit={savePassword} className="space-y-2 border-t border-slate-800 pt-5">
        <label className="block text-xs font-medium text-slate-400">Change password</label>
        <input className={field} type="password" placeholder="Current password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className={field} type="password" placeholder="New password (min 8 characters)" autoComplete="new-password"
          value={next} onChange={(e) => setNext(e.target.value)} />
        <input className={field} type="password" placeholder="Confirm new password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button type="submit" disabled={busy || !current || next.length < 8}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60">
          Change password
        </button>
      </form>
    </div>
  );
}
