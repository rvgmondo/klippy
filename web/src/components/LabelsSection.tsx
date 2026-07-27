import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Plus, Tag } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import type { Label } from '../lib/types';

const SWATCHES = ['#6366f1', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#8b5cf6', '#ec4899'];

export function LabelsSection({ taskId, boardId, current }: { taskId: number; boardId: number; current: Label[] }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(SWATCHES[0]);

  const { data } = useQuery({ queryKey: ['labels'], queryFn: () => apiGet<{ labels: Label[] }>('/labels') });
  const all = data?.labels ?? [];
  const currentIds = new Set(current.map((l) => l.id));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['task', taskId, 'detail'] });
    qc.invalidateQueries({ queryKey: ['board', boardId] });
  };
  const attach = useMutation({ mutationFn: (labelId: number) => apiPost(`/tasks/${taskId}/labels`, { labelId }), onSuccess: invalidate });
  const detach = useMutation({ mutationFn: (labelId: number) => apiDelete(`/tasks/${taskId}/labels/${labelId}`), onSuccess: invalidate });
  const createLabel = useMutation({
    mutationFn: (v: { name: string; color: string }) => apiPost<{ label: Label }>('/labels', v),
    onSuccess: async (res) => {
      setNewName('');
      qc.invalidateQueries({ queryKey: ['labels'] });
      if (res?.label?.id) attach.mutate(res.label.id);
    },
  });

  return (
    <div>
      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">Labels</label>
      <div className="flex flex-wrap items-center gap-1.5">
        {current.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium" style={{ background: `${l.color}22`, color: l.color }}>
            {l.name}
            <button onClick={() => detach.mutate(l.id)} className="hover:opacity-70"><X size={11} /></button>
          </span>
        ))}
        <button onClick={() => setPicking((p) => !p)} className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-800">
          <Tag size={11} /> Add
        </button>
      </div>

      {picking && (
        <div className="mt-2 rounded-lg border border-slate-700 bg-slate-900 p-2">
          <div className="flex flex-wrap gap-1.5">
            {all.filter((l) => !currentIds.has(l.id)).map((l) => (
              <button key={l.id} onClick={() => attach.mutate(l.id)} className="rounded px-2 py-0.5 text-xs font-medium hover:brightness-125" style={{ background: `${l.color}22`, color: l.color }}>
                {l.name}
              </button>
            ))}
            {all.filter((l) => !currentIds.has(l.id)).length === 0 && <span className="text-xs text-slate-500">No other labels yet.</span>}
          </div>
          <div className="mt-2 flex items-center gap-2 border-t border-slate-800 pt-2">
            <div className="flex gap-1">
              {SWATCHES.map((c) => (
                <button key={c} onClick={() => setNewColor(c)} className={`h-4 w-4 rounded-full ${newColor === c ? 'ring-2 ring-white/50' : ''}`} style={{ background: c }} />
              ))}
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) createLabel.mutate({ name: newName.trim(), color: newColor }); }}
              placeholder="New label name" className="flex-1 rounded bg-slate-950 border border-slate-700 px-2 py-1 text-xs text-slate-100 outline-none focus:border-violet-500" />
            <button onClick={() => newName.trim() && createLabel.mutate({ name: newName.trim(), color: newColor })}
              className="grid w-8 place-items-center rounded bg-violet-600 text-[var(--accent-ink)] hover:bg-violet-500"><Plus size={14} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
