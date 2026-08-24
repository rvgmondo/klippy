import { useState } from 'react';
import { confirmDialog } from './ConfirmDialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { Modal } from './Modal';
import { fieldClass } from './ui';

interface PortalUser {
  id: number; email: string; name: string | null;
  isActive: boolean; lastLoginAt: string | null; hasPassword: boolean;
}

/**
 * Who at this client can sign in and see their own account.
 *
 * Access is per person, not per company, so when someone leaves you switch off
 * their address rather than changing a shared password nobody remembers. Switching
 * someone off takes effect on their very next request, not whenever their session
 * happens to expire.
 */
export function PortalAccessModal({ folderId, folderName, onClose }: {
  folderId: number; folderName: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const key = ['portal-users', folderId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiGet<{ portalUsers: PortalUser[] }>(`/folders/${folderId}/portal-users`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const add = useMutation({
    mutationFn: () => apiPost(`/folders/${folderId}/portal-users`, {
      email: email.trim(), name: name.trim() || undefined, invite: true,
    }),
    onSuccess: () => {
      setEmail(''); setName(''); setErr('');
      setNote('Invited. They have been sent a sign-in link.');
      setTimeout(() => setNote(''), 4000);
      refresh();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not add that person.'),
  });

  const toggle = useMutation({
    mutationFn: (v: { id: number; isActive: boolean }) => apiPatch(`/portal-users/${v.id}`, { isActive: v.isActive }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiDelete(`/portal-users/${id}`),
    onSuccess: refresh,
  });
  const invite = useMutation({
    mutationFn: (id: number) => apiPost(`/portal-users/${id}/invite`),
    onSuccess: () => { setNote('Sign-in link sent.'); setTimeout(() => setNote(''), 4000); },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not send that.'),
  });

  /**
   * Portal passwords are hashed, so no screen can show an existing one and
   * Klippy never stores a readable copy. What an admin needs when a client says
   * "I cannot get in" is a working credential to hand over: this generates a
   * strong one, shows it back ONCE, and sends a sign-in link alongside it.
   */
  const [issued, setIssued] = useState<{ email: string; password: string; linkSent: boolean } | null>(null);
  const setPassword = useMutation({
    mutationFn: (id: number) => apiPost<{ password: string; email: string; linkSent: boolean }>(
      `/portal-users/${id}/password`, { sendLink: true }),
    onSuccess: (r) => { setErr(''); setIssued(r); refresh(); },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not set a password.'),
  });
  const clearPassword = useMutation({
    mutationFn: (id: number) => apiPost(`/portal-users/${id}/password`, { password: null }),
    onSuccess: () => { setErr(''); setNote('Password cleared. They sign in with a link now.'); setTimeout(() => setNote(''), 4000); refresh(); },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not clear that.'),
  });

  // Read-only, short-lived, and recorded. Opens in a new tab so the app stays put.
  const preview = useMutation({
    mutationFn: () => apiPost<{ url: string }>(`/folders/${folderId}/portal-preview`),
    // Open only AFTER the cookie is set. Opening first races the request and lands
    // the new tab on the sign-in screen.
    onSuccess: (r) => window.open(r.url || '/?portal=1', '_blank'),
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not start a preview.'),
  });

  const rows = data?.portalUsers ?? [];
  const field = fieldClass;

  return (
    <Modal onClose={onClose} size="md" labelledBy="portal-access-title">
      <div className="p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 id="portal-access-title" className="text-base font-semibold text-slate-100">Portal access</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          People at {folderName} who can sign in to see their invoices and quotes, pay what is
          outstanding, and check their hosting. They only ever see this client's own documents.
        </p>

        {err && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">{err}</p>}
        {note && <p className="mb-3 rounded-lg border border-green-500/30 bg-green-500/10 p-2 text-xs text-green-300">{note}</p>}

        {issued && (
          <div className="mb-3 rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-xs text-green-200">
            <div className="mb-1.5 font-semibold">New portal password for {issued.email}</div>
            <div className="flex flex-wrap items-center gap-2">
              <code className="num rounded bg-slate-950/60 px-2 py-1 text-sm tracking-wide">{issued.password}</code>
              <button onClick={async () => { await navigator.clipboard.writeText(issued.password).catch(() => {}); setNote('Password copied.'); setTimeout(() => setNote(''), 3000); }}
                className="rounded-lg border border-green-500/40 px-2.5 py-1 text-[11px] hover:bg-green-500/10">Copy</button>
              <button onClick={() => setIssued(null)}
                className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800">Done</button>
            </div>
            <p className="mt-1.5 text-[11px] text-green-300/80">
              Shown once and never stored in a readable form, so read it to them now.
              {issued.linkSent ? ' A sign-in link is on its way to them as well.' : ''}
            </p>
          </div>
        )}

        <div className="mb-4 space-y-2">
          {rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
              Nobody has access yet.
            </p>
          )}
          {rows.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 p-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-slate-200">{u.name || u.email}</div>
                <div className="truncate text-[11px] text-slate-500">
                  {u.name ? `${u.email} | ` : ''}
                  {u.lastLoginAt ? `last signed in ${new Date(u.lastLoginAt).toLocaleDateString()}` : 'never signed in'}
                  {u.hasPassword ? ' | has a password' : ''}
                </div>
              </div>
              {!u.isActive && <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">off</span>}
              <button onClick={() => invite.mutate(u.id)} disabled={!u.isActive || invite.isPending}
                className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40">
                Send link
              </button>
              <button onClick={() => setPassword.mutate(u.id)} disabled={setPassword.isPending}
                title="Generate a password you can read out to them. Klippy cannot show an existing one: they are hashed."
                className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40">
                {u.hasPassword ? 'New password' : 'Set password'}
              </button>
              {u.hasPassword && (
                <button onClick={async () => { if (await confirmDialog(`Clear ${u.email}'s password? They will sign in with a one-click link instead.`)) clearPassword.mutate(u.id); }}
                  className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800">
                  Clear password
                </button>
              )}
              <button onClick={() => toggle.mutate({ id: u.id, isActive: !u.isActive })}
                className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">
                {u.isActive ? 'Switch off' : 'Switch on'}
              </button>
              <button onClick={async () => { if (await confirmDialog(`Remove ${u.email}'s access?`, { danger: true })) remove.mutate(u.id); }}
                className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-red-300">
                Remove
              </button>
            </div>
          ))}
        </div>

        <button type="button"
          onClick={() => preview.mutate()}
          disabled={preview.isPending}
          className="mb-2 w-full rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
          {preview.isPending ? 'Opening...' : 'See what this client sees'}
        </button>
        <p className="mb-4 text-[11px] text-slate-500">
          Passwords are stored hashed, so nothing here (and nobody, including you) can read an
          existing one. When someone is locked out, send them a link or set a new password above.
        </p>

        <form className="space-y-2 border-t border-slate-800 pt-4"
          onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={field} type="email" required placeholder="their@email.co.za"
              value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className={field} placeholder="Their name (optional)"
              value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button type="submit" disabled={add.isPending || !email.trim()}
            className="w-full rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50">
            {add.isPending ? 'Inviting...' : 'Give access and send a sign-in link'}
          </button>
        </form>
      </div>
    </Modal>
  );
}
