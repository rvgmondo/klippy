import { useState } from 'react';
import { confirmDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Plus } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import type { Label } from '../lib/types';

const SWATCHES = ['#6366f1', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#8b5cf6', '#ec4899'];

export function LabelsPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['labels'], queryFn: () => apiGet<{ labels: Label[] }>('/labels') });
  const labels = data?.labels ?? [];
  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['labels'] }); };
  const create = useMutation({ mutationFn: () => apiPost('/labels', { name: name.trim(), color }), onSuccess: () => { setName(''); invalidate(); } });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/labels/${id}`), onSuccess: invalidate });

  return (
    <div>
      <p className="mb-3 text-xs text-slate-500">Labels are shared across the workspace. Deleting one removes it from every card.</p>
      <div className="mb-4 space-y-1">
        {labels.map((l) => (
          <div key={l.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-900">
            <span className="h-3 w-3 rounded-full" style={{ background: l.color }} />
            <span className="flex-1 text-sm text-slate-200">{l.name}</span>
            <button onClick={async () => { if (await confirmDialog(`Delete label "${l.name}"?`, { danger: true })) del.mutate(l.id); }} className="hidden text-slate-500 hover:text-red-400 group-hover:block"><Trash2 size={14} /></button>
          </div>
        ))}
        {labels.length === 0 && <p className="px-2 py-4 text-center text-xs text-slate-500">No labels yet.</p>}
      </div>

      <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
        <div className="mb-2 flex gap-1.5">
          {SWATCHES.map((c) => (
            <button key={c} onClick={() => setColor(c)} className={`h-5 w-5 rounded-full ${color === c ? 'ring-2 ring-white/50' : ''}`} style={{ background: c }} />
          ))}
        </div>
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create.mutate(); }}
            placeholder="New label name"
            className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
          <button onClick={() => name.trim() && create.mutate()} className="grid w-10 place-items-center rounded-lg bg-violet-600 text-[var(--accent-ink)] hover:bg-violet-500"><Plus size={16} /></button>
        </div>
      </div>
    </div>
  );
}
