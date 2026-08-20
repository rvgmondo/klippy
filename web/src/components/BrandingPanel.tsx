import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, Trash2 } from 'lucide-react';
import { apiDelete } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fieldClass } from './ui';

export function BrandingPanel() {
  const { account, user, updateAccount, refresh } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const [brand, setBrand] = useState(account?.brandName ?? '');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Bump to bust the browser cache after a new upload.
  const [v, setV] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const field = fieldClass;

  async function saveName() {
    setBusy(true);
    try {
      await updateAccount({ brandName: brand.trim() || null } as never);
      setMsg({ kind: 'ok', text: 'Saved.' });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Could not save.' });
    } finally { setBusy(false); }
  }

  async function upload(file: File) {
    setBusy(true); setMsg(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/v1/account/logo', { method: 'POST', body: form, credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? 'Upload failed.');
      await refresh();
      qc.invalidateQueries();
      setV((n) => n + 1);
      setMsg({ kind: 'ok', text: 'Logo updated.' });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Upload failed.' });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removeLogo() {
    setBusy(true);
    try {
      await apiDelete('/account/logo');
      await refresh();
      setV((n) => n + 1);
      setMsg({ kind: 'ok', text: 'Logo removed.' });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Could not remove.' });
    } finally { setBusy(false); }
  }

  if (!isAdmin) return <p className="text-sm text-slate-400">Only workspace admins can change branding.</p>;

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        Replace the Klippy name and logo shown inside this workspace. Everyone in this
        workspace sees your branding.
      </p>

      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">Product name</label>
        <div className="flex gap-2">
          <input className={field} value={brand} placeholder="Klippy"
            onChange={(e) => setBrand(e.target.value)} />
          <button onClick={saveName} disabled={busy}
            className="shrink-0 rounded-lg bg-violet-600 px-4 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
            Save
          </button>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">Leave blank to keep "Klippy".</p>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-slate-400">Logo</label>
        <div className="flex items-center gap-3">
          <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
            {account?.hasLogo
              ? <img src={`/api/v1/account/logo?v=${v}`} alt="Logo" className="h-full w-full object-contain" />
              : <span className="text-lg font-bold text-slate-500">{(brand || 'K')[0]!.toUpperCase()}</span>}
          </div>
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-60">
            <Upload size={14} /> {account?.hasLogo ? 'Replace' : 'Upload'}
          </button>
          {account?.hasLogo && (
            <button onClick={removeLogo} disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-red-500/10 hover:text-red-400">
              <Trash2 size={14} /> Remove
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">PNG, JPG, WEBP, GIF or SVG. Max 2MB. A square image works best.</p>
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${msg.kind === 'ok'
          ? 'border-green-500/30 bg-green-500/10 text-green-300'
          : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>{msg.text}</div>
      )}
    </div>
  );
}
