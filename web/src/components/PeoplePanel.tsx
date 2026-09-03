import { useState } from 'react';
import { promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Clock, X } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { TeamUser } from '../lib/types';
import { Menu } from './Menu';
import { fieldClass } from './ui';

export function PeoplePanel() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const { data } = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ users: TeamUser[] }>('/users') });
  const users = data?.users ?? [];
  // Someone invited is neither in the workspace nor nowhere: they are waiting on the
  // person they invited. Without this an admin sends an invitation and then has no way
  // to see it, chase it, or take it back.
  const pending = useQuery({
    queryKey: ['invitations'],
    queryFn: () => apiGet<{ invitations: { id: number; email: string; role: string; expiresAt: string }[] }>('/invitations'),
    enabled: isAdmin,
  });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'member' });
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['invitations'] });
  };
  const withdraw = useMutation({
    mutationFn: (id: number) => apiDelete(`/invitations/${id}`),
    onSuccess: invalidate,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { email: form.email.trim(), role: form.role };
      // Existing Klippy logins just get added; only new people need these.
      if (form.name.trim()) body.name = form.name.trim();
      if (form.password) body.password = form.password;
      return apiPost<{ existingLogin?: boolean; invited?: boolean; message?: string }>('/users', body);
    },
    onSuccess: (res) => {
      setAdding(false);
      setForm({ name: '', email: '', password: '', role: 'member' });
      setError(null);
      // Three outcomes now, and the invited one is the common case for anyone who
      // already uses Klippy. Saying "added" when they have only been invited would
      // leave an admin waiting for someone who is waiting for them.
      setNotice(res?.invited
        ? (res.message ?? 'They already had a Klippy login, so we have invited them. They join by accepting it.')
        : res?.existingLogin
          ? 'They already had a Klippy login, so they were added straight to this workspace.'
          : 'Added. Share the temporary password so they can sign in and change it.');
      setTimeout(() => setNotice(null), 9000);
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not add.'),
  });
  const patch = useMutation({ mutationFn: (v: { id: number; body: Record<string, unknown> }) => apiPatch(`/users/${v.id}`, v.body), onSuccess: invalidate });

  const field = fieldClass;

  return (
    <div>
      {isAdmin && !adding && (
        <button onClick={() => setAdding(true)} className="mb-3 flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-[var(--accent-ink)] hover:bg-violet-500">
          <UserPlus size={14} /> Add person
        </button>
      )}

      {adding && (
        <div className="mb-4 space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-3">
          <input className={field} placeholder="Email address" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={field} placeholder="Name (only needed for someone new to Klippy)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={field} type="text" placeholder="Temporary password (only for someone new)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className={field} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <p className="text-[11px] text-slate-500">
            If this email already has a Klippy login (even in another workspace), just enter the
            email and pick a role. Name and password are only needed for someone brand new.
          </p>
          {error && <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">{error}</div>}
          <div className="flex gap-2">
            <button onClick={() => create.mutate()} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-[var(--accent-ink)] hover:bg-violet-500">Create</button>
            <button onClick={() => { setAdding(false); setError(null); }} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
          </div>
        </div>
      )}

      {notice && <div className="mb-3 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-300">{notice}</div>}

      <div className="space-y-1">
        {isAdmin && (pending.data?.invitations.length ?? 0) > 0 && (
          <div className="mb-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
              <Clock size={12} /> Waiting to be accepted
            </div>
            {pending.data!.invitations.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 py-1 text-sm">
                <span className="min-w-0 truncate text-slate-300">{i.email}</span>
                <span className="shrink-0 text-[11px] text-slate-500">
                  {i.role} until {i.expiresAt.slice(0, 10)}
                </span>
                <button onClick={() => withdraw.mutate(i.id)} title="Withdraw this invitation"
                  className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300">
                  <X size={13} />
                </button>
              </div>
            ))}
            <p className="mt-1.5 text-[11px] text-slate-500">
              They already had a Klippy login, so only they can accept. Their password is not affected.
            </p>
          </div>
        )}
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-900">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-violet-600/30 text-xs font-semibold text-violet-200">
              {u.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`truncate text-sm ${u.isActive ? 'text-slate-200' : 'text-slate-500 line-through'}`}>{u.name}</span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">{u.role}</span>
              </div>
              <div className="truncate text-xs text-slate-500">{u.email}</div>
            </div>
            {isAdmin && u.role !== 'owner' && (
              <Menu align="right"
                trigger={<span className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800">Manage</span>}
                items={[
                  { label: u.role === 'admin' ? 'Make member' : 'Make admin', onClick: () => patch.mutate({ id: u.id, body: { role: u.role === 'admin' ? 'member' : 'admin' } }) },
                  { label: u.isActive ? 'Deactivate' : 'Reactivate', onClick: () => patch.mutate({ id: u.id, body: { isActive: !u.isActive } }) },
                  { label: 'Reset password', onClick: async () => { const p = await promptDialog('New password (min 8 chars)'); if (p && p.length >= 8) patch.mutate({ id: u.id, body: { password: p } }); } },
                ]} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
