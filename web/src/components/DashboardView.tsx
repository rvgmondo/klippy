import { useQuery } from '@tanstack/react-query';
import { AlarmClock, CalendarClock, Flag, ListTodo } from 'lucide-react';
import { apiGet } from '../lib/api';
import type { Priority } from '../lib/types';
import { useState } from 'react';
import { CardDetail } from './CardDetail';

interface Dashboard {
  openCount: number;
  dueToday: number;
  overdue: number;
  flagged: number;
  weekSecondsAll: number;
  weekSecondsMine: number;
  upcoming: { id: number; title: string; priority: Priority; dueDate: string; boardId: number }[];
}

const PRIORITY_COLOR: Record<Priority, string> = {
  none: '#6366f1', low: '#64748b', medium: '#eab308', high: '#f97316', urgent: '#ef4444',
};

function fmtHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function DashboardView() {
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => apiGet<Dashboard>('/dashboard') });
  const [openTask, setOpenTask] = useState<{ id: number; boardId: number } | null>(null);

  if (!data) return <div className="p-6 text-sm text-slate-500">Loading dashboard...</div>;

  const tiles = [
    { label: 'Open cards', value: data.openCount, icon: <ListTodo size={18} />, color: '#8b5cf6' },
    { label: 'Due today', value: data.dueToday, icon: <CalendarClock size={18} />, color: '#3b82f6' },
    { label: 'Overdue', value: data.overdue, icon: <AlarmClock size={18} />, color: '#ef4444' },
    { label: 'Flagged', value: data.flagged, icon: <Flag size={18} />, color: '#f97316' },
  ];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
                <span style={{ color: t.color }}>{t.icon}</span> {t.label}
              </div>
              <div className="text-3xl font-semibold text-white">{t.value}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-1 text-xs text-slate-400">Time tracked this week (you)</div>
            <div className="text-2xl font-semibold text-white">{fmtHours(data.weekSecondsMine)}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-1 text-xs text-slate-400">Time tracked this week (everyone)</div>
            <div className="text-2xl font-semibold text-white">{fmtHours(data.weekSecondsAll)}</div>
          </div>
        </div>

        <h3 className="mb-2 mt-8 text-sm font-semibold text-slate-300">Coming up</h3>
        <div className="space-y-2">
          {data.upcoming.length === 0 && <p className="text-sm text-slate-500">Nothing with a due date on the horizon.</p>}
          {data.upcoming.map((t) => (
            <button key={t.id} onClick={() => setOpenTask({ id: t.id, boardId: t.boardId })}
              className="flex w-full items-center gap-3 rounded-xl border border-slate-800 p-3 text-left hover:bg-slate-900">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: PRIORITY_COLOR[t.priority] }} />
              <span className="flex-1 truncate text-sm text-slate-200">{t.title}</span>
              <span className="text-xs text-slate-500">{t.dueDate}</span>
            </button>
          ))}
        </div>
      </div>

      {openTask && <CardDetail taskId={openTask.id} boardId={openTask.boardId} onClose={() => setOpenTask(null)} />}
    </div>
  );
}
