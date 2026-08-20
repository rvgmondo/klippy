import { useState } from 'react';
import { confirmDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fieldInlineClass } from './ui';

interface TeamMember { userId: number; name: string | null; email: string | null }
interface Team { id: number; name: string; color: string; members: TeamMember[] }
interface Person { id: number; name: string; email: string; isActive: boolean }

const COLORS = ['#6366f1', '#22c55e', '#f97316', '#ef4444', '#eab308', '#06b6d4'];

export function TeamsPanel() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [error, setError] = useState<string | null>(null);

  const teams = useQuery({ queryKey: ['teams'], queryFn: () => apiGet<{ teams: Team[] }>('/teams') });
  const people = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ users: Person[] }>('/users') });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['teams'] });

  const create = useMutation({
    mutationFn: () => apiPost('/teams', { name: name.trim(), color }),
    onSuccess: () => { setName(''); invalidate(); },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not create the team.'),
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/teams/${id}`), onSuccess: invalidate });
  const addMember = useMutation({
    mutationFn: (v: { teamId: number; userId: number }) => apiPost(`/teams/${v.teamId}/members`, { userId: v.userId }),
    onSuccess: invalidate,
  });
  const removeMember = useMutation({
    mutationFn: (v: { teamId: number; userId: number }) => apiDelete(`/teams/${v.teamId}/members/${v.userId}`),
    onSuccess: invalidate,
  });

  const field = fieldInlineClass;

  if (!isAdmin) {
    return <p className="text-sm text-slate-400">Only workspace admins can manage teams.</p>;
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        Teams are named groups of people (Design, Ops, Support). Create one, add people, and you can attach it to a board.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input className={field + ' flex-1 min-w-40'} placeholder="Team name" value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create.mutate(); }} />
        <div className="flex gap-1">
          {COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} title={c}
              className={`h-7 w-7 rounded-full border-2 ${color === c ? 'border-white' : 'border-transparent'}`}
              style={{ background: c }} />
          ))}
        </div>
        <button onClick={() => name.trim() && create.mutate()} disabled={!name.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
          <Plus size={15} /> Add team
        </button>
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      <div className="space-y-3">
        {(teams.data?.teams ?? []).length === 0 && (
          <p className="text-sm text-slate-500">No teams yet.</p>
        )}
        {(teams.data?.teams ?? []).map((t) => {
          const memberIds = new Set(t.members.map((m) => m.userId));
          const available = (people.data?.users ?? []).filter((p) => p.isActive && !memberIds.has(p.id));
          return (
            <div key={t.id} className="rounded-xl border border-slate-800 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: t.color }} />
                <span className="flex-1 text-sm font-medium text-slate-200">{t.name}</span>
                <button onClick={async () => { if (await confirmDialog(`Delete team "${t.name}"?`, { danger: true })) del.mutate(t.id); }}
                  className="text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
              </div>

              <div className="mb-2 flex flex-wrap gap-1.5">
                {t.members.length === 0 && <span className="text-xs text-slate-500">No members yet.</span>}
                {t.members.map((m) => (
                  <span key={m.userId} className="flex items-center gap-1 rounded-full bg-slate-800 py-1 pl-2.5 pr-1 text-xs text-slate-200">
                    {m.name ?? m.email}
                    <button onClick={() => removeMember.mutate({ teamId: t.id, userId: m.userId })}
                      className="grid h-4 w-4 place-items-center rounded-full text-slate-400 hover:bg-slate-700 hover:text-red-400">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>

              {available.length > 0 && (
                <select className={field + ' w-full'} value=""
                  onChange={(e) => { const v = Number(e.target.value); if (v) addMember.mutate({ teamId: t.id, userId: v }); }}>
                  <option value="">Add someone...</option>
                  {available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
