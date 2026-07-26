import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock, CalendarClock, Flag, ListTodo, Target, Truck, Settings2, ArrowRight,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Priority, Folder } from '../lib/types';
import { CardDetail } from './CardDetail';

interface Bucket { open: number; dueToday: number; overdue: number; flagged: number; weekSeconds: number }
interface Dashboard {
  delivery: Bucket; operations: Bucket;
  weekSecondsMine: number;
  upcoming: { id: number; title: string; priority: Priority; dueDate: string; boardId: number }[];
  // legacy flat fields still returned by the API
  openCount: number; dueToday: number; overdue: number; flagged: number; weekSecondsAll: number;
}
interface DealSummary { openCount: number; pipelineValue: number; wonThisMonth: number; wonValueThisMonth: number }

const PRIORITY_COLOR: Record<Priority, string> = {
  none: '#6366f1', low: '#64748b', medium: '#eab308', high: '#f97316', urgent: '#ef4444',
};
function fmtHours(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function DashboardView({ onNavigate }: { onNavigate?: (v: string) => void }) {
  const { account } = useAuth();
  const cur = account?.currency ?? 'ZAR';
  const money = (v: number) => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v); }
    catch { return `${cur} ${v.toFixed(0)}`; }
  };
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => apiGet<Dashboard>('/dashboard') });
  const deals = useQuery({ queryKey: ['deals'], queryFn: () => apiGet<{ summary: DealSummary }>('/deals') });
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const [openTask, setOpenTask] = useState<{ id: number; boardId: number } | null>(null);

  const opsFolders = (folders.data?.folders ?? []).filter((f) => f.parentId === null && (f as Folder & { pillar?: string }).pillar === 'operations');

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{account?.name ?? 'Your business'}</h1>
          <p className="text-sm text-slate-500">The three engines of your business, at a glance.</p>
        </div>

        {/* ACQUISITION */}
        <Pillar icon={<Target size={16} />} title="Acquisition" subtitle="Bring buyers in the door"
          action={onNavigate ? { label: 'Open pipeline', onClick: () => onNavigate('pipeline') } : undefined}>
          <Tile label="Open deals" value={String(deals.data?.summary.openCount ?? 0)} icon={<Target size={18} />} color="#8b5cf6" />
          <Tile label="Pipeline value" value={money(deals.data?.summary.pipelineValue ?? 0)} icon={<Target size={18} />} color="#6366f1" />
          <Tile label="Won this month" value={String(deals.data?.summary.wonThisMonth ?? 0)} icon={<Target size={18} />} color="#22c55e" />
          <Tile label="Won value (month)" value={money(deals.data?.summary.wonValueThisMonth ?? 0)} icon={<Target size={18} />} color="#22c55e" />
        </Pillar>

        {/* DELIVERY */}
        <Pillar icon={<Truck size={16} />} title="Delivery" subtitle="Serve the customer, get paid"
          action={onNavigate ? { label: 'Reports', onClick: () => onNavigate('reports') } : undefined}>
          <Tile label="Open work" value={String(data?.delivery.open ?? 0)} icon={<ListTodo size={18} />} color="#8b5cf6" />
          <Tile label="Due today" value={String(data?.delivery.dueToday ?? 0)} icon={<CalendarClock size={18} />} color="#3b82f6" />
          <Tile label="Overdue" value={String(data?.delivery.overdue ?? 0)} icon={<AlarmClock size={18} />} color="#ef4444" />
          <Tile label="Flagged" value={String(data?.delivery.flagged ?? 0)} icon={<Flag size={18} />} color="#f97316" />
          <Tile label="Time this week (client work)" value={fmtHours(data?.delivery.weekSeconds ?? 0)} icon={<CalendarClock size={18} />} color="#06b6d4" />
          <Tile label="Time this week (you)" value={fmtHours(data?.weekSecondsMine ?? 0)} icon={<CalendarClock size={18} />} color="#06b6d4" />
        </Pillar>

        {(data?.upcoming.length ?? 0) > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-300">Coming up</h3>
            <div className="space-y-2">
              {data!.upcoming.map((t) => (
                <button key={t.id} onClick={() => setOpenTask({ id: t.id, boardId: t.boardId })}
                  className="flex w-full items-center gap-3 rounded-xl border border-slate-800 p-3 text-left hover:bg-slate-900">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: PRIORITY_COLOR[t.priority] }} />
                  <span className="flex-1 truncate text-sm text-slate-200">{t.title}</span>
                  <span className="text-xs text-slate-500">{t.dueDate}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* OPERATIONS */}
        <Pillar icon={<Settings2 size={16} />} title="Operations" subtitle="Run the machine (internal work)">
          <Tile label="Open work" value={String(data?.operations.open ?? 0)} icon={<ListTodo size={18} />} color="#8b5cf6" />
          <Tile label="Due today" value={String(data?.operations.dueToday ?? 0)} icon={<CalendarClock size={18} />} color="#3b82f6" />
          <Tile label="Overdue" value={String(data?.operations.overdue ?? 0)} icon={<AlarmClock size={18} />} color="#ef4444" />
          <Tile label="Time this week" value={fmtHours(data?.operations.weekSeconds ?? 0)} icon={<CalendarClock size={18} />} color="#06b6d4" />
        </Pillar>

        {/* Internal areas list (Operations detail) */}
        {opsFolders.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {opsFolders.slice(0, 8).map((f) => (
              <button key={f.id} onClick={() => onNavigate?.('board')}
                className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-left hover:bg-slate-900">
                <div className="text-xs text-slate-400">Internal area</div>
                <div className="truncate text-lg font-semibold text-slate-100">{f.name}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-700 p-4 text-sm text-slate-400">
            No internal areas yet. In the sidebar, add a folder and set it to <span className="text-slate-200">Operations</span> for things like admin, hiring or finance, separate from client work.
          </div>
        )}
      </div>

      {openTask && <CardDetail taskId={openTask.id} boardId={openTask.boardId} onClose={() => setOpenTask(null)} />}
    </div>
  );
}

function Pillar({ icon, title, subtitle, action, children }: {
  icon: ReactNode; title: string; subtitle: string; action?: { label: string; onClick: () => void }; children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-violet-600/15 text-violet-300">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <p className="text-[11px] text-slate-500">{subtitle}</p>
        </div>
        {action && (
          <button onClick={action.onClick} className="ml-auto flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200">
            {action.label} <ArrowRight size={13} />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">{children}</div>
    </section>
  );
}

function Tile({ label, value, icon, color }: { label: string; value: string; icon: ReactNode; color: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
        <span style={{ color }}>{icon}</span> {label}
      </div>
      <div className="text-2xl font-semibold text-slate-100">{value}</div>
    </div>
  );
}
