import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Square, Plus, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import { useRunningTimer } from './TimerChip';
import { fieldInlineClass } from './ui';

interface Entry {
  id: number;
  userId: number;
  startTime: string;
  endTime: string | null;
  durationSeconds: number | null;
  note: string | null;
  isManual: boolean;
}

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function TimeSection({ taskId }: { taskId: number }) {
  const qc = useQueryClient();
  const key = ['task', taskId, 'time'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiGet<{ entries: Entry[]; totalSeconds: number }>(`/tasks/${taskId}/time`),
  });
  const { data: timer } = useRunningTimer();
  const runningHere = timer?.current?.taskId === taskId;

  const [showManual, setShowManual] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['timer'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const start = useMutation({ mutationFn: () => apiPost('/timer/start', { taskId }), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => apiPost('/timer/stop'), onSuccess: invalidate });
  const manual = useMutation({
    mutationFn: (v: { minutes: number; note?: string }) => apiPost('/timer/manual', { taskId, ...v }),
    onSuccess: () => { setShowManual(false); setMinutes(''); setNote(''); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/time-entries/${id}`), onSuccess: invalidate });

  const field = fieldInlineClass;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Time</label>
        <span className="text-xs text-slate-400">{fmt(data?.totalSeconds ?? 0)} total</span>
      </div>

      <div className="flex gap-2">
        {runningHere ? (
          <button onClick={() => stop.mutate()}
            className="flex items-center gap-1.5 rounded-lg bg-green-600/20 px-3 py-1.5 text-xs text-green-300 hover:bg-green-600/30">
            <Square size={12} fill="currentColor" /> Stop timer
          </button>
        ) : (
          <button onClick={() => start.mutate()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            <Play size={12} /> Start timer
          </button>
        )}
        <button onClick={() => setShowManual((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
          <Plus size={12} /> Log time
        </button>
      </div>

      {showManual && (
        <div className="mt-2 flex gap-2">
          <input className={field + ' w-24'} type="number" min={1} placeholder="Minutes"
            value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          <input className={field + ' flex-1'} placeholder="Note (optional)"
            value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            onClick={() => { const m = parseInt(minutes, 10); if (m > 0) manual.mutate({ minutes: m, note: note.trim() || undefined }); }}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-[var(--accent-ink)] hover:bg-violet-500">Add</button>
        </div>
      )}

      {(data?.entries.length ?? 0) > 0 && (
        <div className="mt-3 space-y-1">
          {data!.entries.map((e) => (
            <div key={e.id} className="group flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-slate-900">
              <span className="text-slate-400">{new Date(e.startTime).toLocaleDateString()}</span>
              <span className="flex-1 truncate text-slate-500">{e.note ?? (e.isManual ? 'manual entry' : 'timer')}</span>
              <span className="num text-slate-300">
                {e.endTime === null ? 'running...' : fmt(e.durationSeconds ?? 0)}
              </span>
              <button onClick={() => del.mutate(e.id)}
                className="hidden text-slate-500 hover:text-red-400 group-hover:block"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
