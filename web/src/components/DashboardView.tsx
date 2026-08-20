import { useQuery } from '@tanstack/react-query';
import { Target, Truck, Settings2, ArrowRight, ArrowUpRight, StickyNote, Palette } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { apiGet } from '../lib/api';
import { TodayBriefing } from './TodayBriefing';
import { SkeletonTile } from './ui';
import { useAuth } from '../lib/auth';
import type { Priority, Folder, Business } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';
import { CardDetail } from './CardDetail';
import { BusinessNotes } from './BusinessNotes';
import { ErrorNote } from './ErrorNote';
import { moneyRound } from '../lib/money';
import { useCurrency } from '../lib/useCurrency';

interface Bucket { open: number; dueToday: number; overdue: number; flagged: number; weekSeconds: number }
interface BizRoll { id: number; name: string; open: number; weekSeconds: number }
interface Dashboard {
  delivery: Bucket; operations: Bucket;
  weekSecondsMine: number;
  upcoming: { id: number; title: string; priority: Priority; dueDate: string; boardId: number }[];
  businesses: BizRoll[];
  openCount: number; dueToday: number; overdue: number; flagged: number; weekSecondsAll: number;
}
interface DealSummary { openCount: number; pipelineValue: number; wonThisMonth: number; wonValueThisMonth: number }
interface MoneyTotals { expenses: number; profit: number; mrr: number }

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function todayStr(): string { return new Date().toISOString().slice(0, 10); }

function fmtHours(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function DashboardView({ businessId, onNavigate, onPickBusiness }: {
  businessId: BusinessSelection;
  onNavigate?: (v: string) => void;
  onPickBusiness?: (id: number) => void;
}) {
  const { user } = useAuth();
  const cur = useCurrency(businessId);
  const money = (v: number) => moneyRound(v, cur);
  const bizQ = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data, error, refetch, isLoading } = useQuery({ queryKey: ['dashboard', businessId], queryFn: () => apiGet<Dashboard>(`/dashboard${bizQ}`), retry: false });
  const deals = useQuery({ queryKey: ['deals', businessId], queryFn: () => apiGet<{ summary: DealSummary }>(`/deals${bizQ}`) });
  const money_ = useQuery({
    queryKey: ['dashboard-money', businessId],
    queryFn: () => apiGet<{ totals: MoneyTotals }>(`/reports/time?from=${monthStart()}&to=${todayStr()}${bizQ ? '&' + bizQ.slice(1) : ''}`),
  });
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const businessesQ = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const [openTask, setOpenTask] = useState<{ id: number; boardId: number } | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  // The focused business, when one is selected (needed for its notes).
  const focused = businessId === 'all' ? null : (businessesQ.data?.businesses ?? []).find((b) => b.id === businessId) ?? null;

  const d = data;
  const ds = deals.data?.summary;
  const bizList = d?.businesses ?? [];
  const opsFolders = (folders.data?.folders ?? []).filter((f) =>
    f.parentId === null && f.pillar === 'operations' && (businessId === 'all' || f.businessId === businessId));

  const heading = businessId === 'all'
    ? `${greeting()}, ${user?.name?.split(' ')[0] ?? 'there'}`
    : (bizList.find((b) => b.id === businessId)?.name ?? 'Business');
  const sub = businessId === 'all'
    ? "Here's where your businesses stand today."
    : 'The three engines of this business, at a glance.';

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Hero */}
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-100">{heading}</h1>
            <p className="mt-0.5 text-sm text-slate-500">{sub}</p>
          </div>
          <div className="flex items-center gap-3">
            {focused && (
              <button onClick={() => {
                  // One door for business settings: the Settings screen. The modal
                  // this used to open was a second copy of the same forms.
                  const q = new URLSearchParams(window.location.search);
                  q.set('s', 'biz:brand');
                  window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
                  onNavigate?.('settings');
                }}
                title="Brand and invoicing for this business (in Settings)"
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                <Palette size={14} />
                <span className="hidden sm:inline">Business</span>
              </button>
            )}
            {focused && (
              <button onClick={() => setShowNotes(true)}
                title="Notes for this business"
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                <StickyNote size={14} />
                <span className="hidden sm:inline">Notes</span>
                {focused.notes?.trim() && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
              </button>
            )}
            <div className="hidden text-right text-xs text-slate-500 sm:block">
              <span className="num text-slate-300">{todayLabel()}</span>
              {businessId === 'all' && bizList.length > 0 && (
                <><span className="mx-2 inline-block h-1 w-1 rounded-full bg-slate-600 align-middle"></span>{bizList.length} {bizList.length === 1 ? 'business' : 'businesses'}</>
              )}
            </div>
          </div>
        </div>

        {/* A failed load used to render as a wall of zeros, which is worse than an
            error when the numbers are money. */}
        {error && <ErrorNote error={error} onRetry={() => refetch()} />}

        {/* What needs you today, and the one thing holding the business back. */}
        <TodayBriefing businessId={businessId} onNavigate={(v) => onNavigate?.(v)} />

        {/* Pillar bento. While the numbers are still counting, shimmer instead of
            flashing zeros: "R 0 revenue" on open reads as bad news, not a wait. */}
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <SkeletonTile /><SkeletonTile /><SkeletonTile />
          </div>
        ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <PillarCard
            icon={<Target size={15} />} name="Sales" accent
            status="Bring buyers in" hero={money(ds?.pipelineValue ?? 0)} heroLabel="Pipeline value"
            onOpen={onNavigate ? () => onNavigate('pipeline') : undefined}
            subs={[['Open deals', String(ds?.openCount ?? 0)], ['Won / mo', String(ds?.wonThisMonth ?? 0)], ['Won value', money(ds?.wonValueThisMonth ?? 0)]]} />
          <PillarCard
            icon={<Truck size={15} />} name="Client work"
            status={`${d?.delivery.open ?? 0} open`} hero={String(d?.delivery.open ?? 0)} heroLabel="Open work"
            onOpen={onNavigate ? () => onNavigate('reports') : undefined}
            subs={[['Due today', String(d?.delivery.dueToday ?? 0)], ['Overdue', String(d?.delivery.overdue ?? 0)], ['This week', fmtHours(d?.delivery.weekSeconds ?? 0)]]} />
          <PillarCard
            icon={<Settings2 size={15} />} name="Internal work"
            status={`${opsFolders.length} area${opsFolders.length === 1 ? '' : 's'}`} hero={String(d?.operations.open ?? 0)} heroLabel="Open work"
            subs={[['Due today', String(d?.operations.dueToday ?? 0)], ['Overdue', String(d?.operations.overdue ?? 0)], ['This week', fmtHours(d?.operations.weekSeconds ?? 0)]]} />
        </div>
        )}

        {/* Businesses and the rest */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {businessId === 'all' && bizList.length > 1 ? (
            <Panel>
              <PanelHead title="Businesses" meta="tap to focus" />
              <div className="-mx-1">
                {bizList.map((b) => (
                  <button key={b.id} onClick={() => onPickBusiness?.(b.id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-800/50">
                    <span className="flex-1 truncate text-sm text-slate-200">{b.name}</span>
                    <span className="num text-[11px] text-slate-500">{b.open} open, {fmtHours(b.weekSeconds)}</span>
                    <ArrowUpRight size={13} className="text-slate-600" />
                  </button>
                ))}
              </div>
            </Panel>
          ) : (
            <Panel>
              <PanelHead title="This week" meta="your time" />
              <div className="flex h-[calc(100%-2rem)] flex-col justify-center">
                <div className="num text-4xl font-semibold text-violet-300">{fmtHours(d?.weekSecondsMine ?? 0)}</div>
                <div className="mt-1 text-xs text-slate-500">tracked by you</div>
              </div>
            </Panel>
          )}
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label="Won this month" value={money(ds?.wonValueThisMonth ?? 0)} accent />
          <Kpi label="Pipeline" value={money(ds?.pipelineValue ?? 0)} />
          <Kpi label="Profit this month" value={money(money_.data?.totals.profit ?? 0)}
            accent={(money_.data?.totals.profit ?? 0) >= 0} warn={(money_.data?.totals.profit ?? 0) < 0} />
          <Kpi label="MRR" value={money(money_.data?.totals.mrr ?? 0)}
            onClick={onNavigate ? () => onNavigate('offerings') : undefined} />
          {/* "Overdue" alone read as overdue MONEY next to the constraint panel,
              which counts invoices. This one has always been about work. */}
          <Kpi label="Overdue work" value={String((d?.delivery.overdue ?? 0) + (d?.operations.overdue ?? 0))} />
          <Kpi label="Time this week" value={fmtHours(d?.weekSecondsAll ?? 0)} />
        </div>

        {opsFolders.length === 0 && businessId !== 'all' && (
          <div className="rounded-xl border border-dashed border-slate-700 p-4 text-sm text-slate-400">
            No internal areas yet. In the sidebar, add a folder and set it to <span className="text-slate-200">Operations</span> for admin, hiring or finance, separate from client work.
          </div>
        )}
      </div>

      {openTask && <CardDetail taskId={openTask.id} boardId={openTask.boardId} onClose={() => setOpenTask(null)} />}
      {showNotes && focused && (
        <BusinessNotes businessId={focused.id} businessName={focused.name}
          initial={focused.notes ?? ''} onClose={() => setShowNotes(false)} />
      )}

    </div>
  );
}

function PillarCard({ icon, name, status, hero, heroLabel, subs, accent, onOpen }: {
  icon: ReactNode; name: string; status: string; hero: string; heroLabel: string;
  subs: [string, string][]; accent?: boolean; onOpen?: () => void;
}) {
  return (
    <div className="group rounded-2xl border border-slate-800 bg-slate-900 p-5 transition hover:-translate-y-0.5 hover:border-slate-700">
      <div className="mb-4 flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-800 text-violet-300">{icon}</span>
        <span className="font-display text-[15px] font-semibold text-slate-100">{name}</span>
        {onOpen ? (
          <button onClick={onOpen} className="ml-auto flex items-center gap-1 text-[11px] uppercase tracking-wide text-violet-300 opacity-70 hover:opacity-100">
            {status} <ArrowRight size={12} />
          </button>
        ) : (
          <span className="ml-auto text-[11px] uppercase tracking-wide text-slate-500">{status}</span>
        )}
      </div>
      <div className={`num text-4xl font-semibold leading-none ${accent ? 'text-violet-300' : 'text-slate-100'}`}>{hero}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-slate-500">{heroLabel}</div>
      <div className="mt-4 flex gap-5 border-t border-slate-800 pt-4">
        {subs.map(([k, v]) => (
          <div key={k}>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">{k}</div>
            <div className="num mt-1 text-base text-slate-200">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-800 bg-slate-900 p-5 ${className}`}>{children}</div>;
}
function PanelHead({ title, meta, action }: { title: string; meta?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="font-display text-sm font-semibold text-slate-100">{title}</span>
      {meta && <span className="text-[11px] text-slate-500">{meta}</span>}
      {action && (
        <button onClick={action.onClick} className="ml-auto flex items-center gap-1 text-[11px] text-violet-300 hover:opacity-80">
          {action.label} <ArrowRight size={12} />
        </button>
      )}
    </div>
  );
}
function Kpi({ label, value, accent, warn, onClick }: { label: string; value: string; accent?: boolean; warn?: boolean; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp onClick={onClick} className={`rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-left ${onClick ? 'hover:border-slate-700 hover:bg-slate-900' : ''}`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`num mt-1.5 text-xl font-semibold ${warn ? 'text-red-400' : accent ? 'text-violet-300' : 'text-slate-100'}`}>{value}</div>
    </Comp>
  );
}
