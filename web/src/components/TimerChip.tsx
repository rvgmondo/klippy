import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Square, Clock } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';

interface Current {
  current: { id: number; taskId: number; startTime: string; taskTitle: string | null } | null;
}

export function useRunningTimer() {
  return useQuery({
    queryKey: ['timer'],
    queryFn: () => apiGet<Current>('/timer/current'),
    refetchInterval: 30000,
  });
}

/** Green pill in the top bar while a work timer runs; click square to stop. */
export function TimerChip() {
  const qc = useQueryClient();
  const { data } = useRunningTimer();
  const [, tick] = useState(0);

  const running = data?.current ?? null;

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useMutation({
    mutationFn: () => apiPost('/timer/stop'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timer'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  if (!running) return null;

  const secs = Math.max(0, Math.floor((Date.now() - new Date(running.startTime).getTime()) / 1000));
  const hh = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');

  return (
    <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-2.5 py-1.5">
      <Clock size={13} className="text-green-400" />
      <span className="max-w-32 truncate text-xs text-green-200">{running.taskTitle ?? 'Working...'}</span>
      <span className="text-xs font-medium num text-green-300">
        {hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`}
      </span>
      <button onClick={() => stop.mutate()} title="Stop timer"
        className="grid h-5 w-5 place-items-center rounded text-green-300 hover:bg-green-500/20">
        <Square size={11} fill="currentColor" />
      </button>
    </div>
  );
}
