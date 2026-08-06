import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Target, Receipt, CalendarCheck, Repeat, Flame } from 'lucide-react';
import { apiGet } from '../lib/api';
import type { BusinessSelection } from './BusinessSwitcher';

type Urgency = 'critical' | 'high' | 'normal';
interface FeedItem {
  kind: string; urgency: Urgency; title: string; detail: string;
  view: string; amount?: number; days?: number;
}
interface Constraint {
  key: string; title: string; detail: string; action: string; view: string; alternatives: string[];
}
interface Command {
  constraint: Constraint | null;
  feed: FeedItem[];
  counts: {
    overdueInvoices: number; owed: number; overdueTasks: number; dueToday: number;
    openDeals: number; pipelineValue: number; staleDeals: number;
  };
}

const KIND_ICON: Record<string, typeof Target> = {
  invoice_overdue: Receipt, invoice_suspended: AlertTriangle,
  task_overdue: CalendarCheck, task_today: CalendarCheck,
  deal_stale: Target, subscription_due: Repeat,
};

const URGENCY_STYLE: Record<Urgency, string> = {
  critical: 'border-red-500/30 bg-red-500/5 text-red-300',
  high: 'border-amber-500/25 bg-amber-500/5 text-amber-300',
  normal: 'border-slate-800 bg-slate-900/40 text-slate-400',
};

/**
 * What actually needs you today, and the one thing holding the business back.
 *
 * The old Home showed counts and an "Up next" box that said "Nothing due. Clear
 * runway." while an invoice sat three weeks overdue, because it only looked at task
 * due dates. This looks across money, work and pipeline together, so silence here
 * genuinely means there is nothing to do.
 */
export function CommandCentre({ businessId, onNavigate }: {
  businessId: BusinessSelection;
  onNavigate: (view: string) => void;
}) {
  const bizQ = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data } = useQuery({
    queryKey: ['command-centre', businessId],
    queryFn: () => apiGet<Command>(`/command-centre${bizQ}`),
  });
  if (!data) return null;

  return (
    <div className="space-y-4">
      {/* The bottleneck */}
      {data.constraint ? (
        <button onClick={() => onNavigate(data.constraint!.view)}
          className="group w-full rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-quiet)] p-4 text-left transition hover:border-[var(--accent)]/60">
          <div className="flex items-start gap-3">
            <Flame size={18} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                Your constraint right now
              </div>
              <div className="mt-0.5 font-display text-lg font-bold text-slate-100">{data.constraint.title}</div>
              <p className="mt-1 text-sm text-slate-300">{data.constraint.detail}</p>
              <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-[var(--accent)]">
                {data.constraint.action}
                <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
              </p>
              {data.constraint.alternatives.length > 0 && (
                <p className="mt-2 text-[11px] text-slate-500">
                  Also worth a look once this is handled: {data.constraint.alternatives.join(', ')}.
                </p>
              )}
            </div>
          </div>
        </button>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div className="font-display text-base font-semibold text-slate-100">Nothing is blocking you</div>
          <p className="mt-0.5 text-sm text-slate-500">
            No overdue money, a pipeline with something in it, and delivery on time. Good place to be.
          </p>
        </div>
      )}

      {/* What needs doing */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Needs you today</h2>
          {data.feed.length > 0 && (
            <span className="text-[11px] text-slate-600">worst first</span>
          )}
        </div>
        {data.feed.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500">
            Nothing overdue, nothing due today, and no deal going cold.
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.feed.map((f, i) => {
              const Icon = KIND_ICON[f.kind] ?? Target;
              return (
                <button key={i} onClick={() => onNavigate(f.view)}
                  className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition hover:border-slate-600 ${URGENCY_STYLE[f.urgency]}`}>
                  <Icon size={15} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-slate-100">{f.title}</div>
                    <div className="truncate text-[11px] text-slate-500">{f.detail}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
