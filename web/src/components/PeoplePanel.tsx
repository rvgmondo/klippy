import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { apiGet, apiPost, apiPatch } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { TeamUser } from '../lib/types';
import { Menu } from './Menu';

export function PeoplePanel() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const { data } = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ users: TeamUser[] }>('/users') });
  const users = data?.users ?? [];

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'member' });
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });
  const create = useMutation({
    mutationFn: () => apiPost('/users', form),
    onSuccess: () => { setAdding(false); setForm({ name: '', email: '', password: '', role: 'member' }); setError(null); invalidate(); },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not add.'),
  });
  const patch = useMutation({ mutationFn: (v: { id: number; body: Record<string, unknown> }) => apiPatch(`/users/${v.id}`, v.body), onSuccess: invalidate });

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500';

  return (
    <div>
      {isAdmin && !adding && (
        <button onClick={() => setAdding(true)} className="mb-3 flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500">
          <UserPlus size={14} /> Add person
        </button>
      )}

      {adding && (
        <div className="mb-4 space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-3">
          <input className={field} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={field} placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={field} type="text" placeholder="Temporary password (min 8 chars)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className={field} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <p className="text-[11px] text-slate-500">No email invites yet, so set a temporary password and share it with them to change after login.</p>
          {error && <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">{error}</div>}
          <div className="flex gap-2">
            <button onClick={() => create.mutate()} className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-500">Create</button>
            <button onClick={() => { setAdding(false); setError(null); }} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-1">
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
                  { label: 'Reset password', onClick: () => { const p = window.prompt('New password (min 8 chars)'); if (p && p.length >= 8) patch.mutate({ id: u.id, body: { password: p } }); } },
                ]} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
