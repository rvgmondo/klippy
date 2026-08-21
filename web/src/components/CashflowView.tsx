import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { ErrorNote } from './ErrorNote';
import type { BusinessSelection } from './BusinessSwitcher';
import { money } from '../lib/money';
import { SkeletonTile } from './ui';

interface Bucket { start: string; end: string; invoices: number; subscriptions: number; total: number }
interface Lane {
  currency: string;
  overdue: number; overdueCount: number;
  /** Invoices due beyond the eight weeks shown. */
  later: number;
  buckets: Bucket[];
  expected: number;
}
interface Cashflow { start: string; weeks: number; currencies: Lane[] }

const shortDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

/**
 * The next eight weeks of money, per currency: unpaid invoices bucketed by due
 * date, subscriptions projected forward at their real cadence, and what is already
 * overdue kept honest in its own column instead of pretending it arrives this week.
 * The question this answers is the founder's 2am one: is anything actually coming in?
 */
export function CashflowView({ businessId }: { businessId: BusinessSelection }) {
  const bizQ = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['cashflow', businessId],
    queryFn: () => apiGet<Cashflow>(`/reports/cashflow${bizQ}`),
    retry: false,
  });

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-100">Cash flow</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            What should arrive over the next eight weeks, from invoices already out and subscriptions still to bill.
          </p>
        </div>

        {error && <ErrorNote error={error} onRetry={() => refetch()} />}
        {isLoading && <div className="grid gap-4 sm:grid-cols-3"><SkeletonTile /><SkeletonTile /><SkeletonTile /></div>}

        {data && data.currencies.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
            Nothing to forecast yet. Send an invoice or start a subscription and the weeks fill in.
          </div>
        )}

        {data?.currencies.map((lane) => <CurrencyLane key={lane.currency} lane={lane} many={data.currencies.length > 1} />)}

        {data && data.currencies.length > 0 && (
          <p className="text-[11px] text-slate-500">
            A forecast of what should arrive, not a promise. Invoices count in the week they fall due;
            subscriptions count in the week they bill, at what each client actually pays. Currencies are never added together.
          </p>
        )}
      </div>
    </div>
  );
}

function CurrencyLane({ lane, many }: { lane: Lane; many: boolean }) {
  const peak = Math.max(...lane.buckets.map((b) => b.total), lane.overdue, 1);

  return (
    <section className="space-y-4">
      {many && <h2 className="text-sm font-semibold text-slate-300">{lane.currency}</h2>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Kpi label={`Expected in 8 weeks${many ? ` (${lane.currency})` : ''}`} value={money(lane.expected, lane.currency)} />
        <Kpi label={`Already overdue${lane.overdueCount ? ` (${lane.overdueCount})` : ''}`}
          value={money(lane.overdue, lane.currency)} warn={lane.overdue > 0} />
        <Kpi label="Due after that" value={money(lane.later, lane.currency)} />
      </div>

      {/* One column per week, invoices and subscriptions stacked. Bars, because the
          question is "which weeks are thin", and a table hides that shape. */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="grid grid-cols-9 gap-2">
          <BarColumn label="Overdue" value={lane.overdue} peak={peak} currency={lane.currency}
            segments={[{ amount: lane.overdue, className: 'bg-red-500/70' }]} />
          {lane.buckets.map((b) => (
            <BarColumn key={b.start} label={shortDate(b.start)} value={b.total} peak={peak} currency={lane.currency}
              segments={[
                { amount: b.invoices, className: 'bg-violet-500/80' },
                { amount: b.subscriptions, className: 'bg-sky-500/70' },
              ]} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-violet-500/80" /> Invoices due</span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-sky-500/70" /> Subscriptions billing</span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-red-500/70" /> Overdue</span>
        </div>
      </div>
    </section>
  );
}

function BarColumn({ label, value, peak, currency, segments }: {
  label: string; value: number; peak: number; currency: string;
  segments: { amount: number; className: string }[];
}) {
  return (
    <div className="flex flex-col items-center gap-1.5" title={value > 0 ? money(value, currency) : 'Nothing'}>
      <div className="num text-[10px] text-slate-400">{value > 0 ? money(value, currency) : ''}</div>
      <div className="flex h-28 w-full max-w-10 flex-col justify-end gap-px overflow-hidden rounded-t">
        {segments.filter((s) => s.amount > 0).map((s, i) => (
          <div key={i} className={s.className} style={{ height: `${Math.max(3, (s.amount / peak) * 100)}%` }} />
        ))}
      </div>
      <div className="border-t border-slate-700 pt-1 text-[10px] text-slate-500">{label}</div>
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${warn ? 'border-red-500/30 bg-red-500/5' : 'border-slate-800 bg-slate-900/40'}`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`num mt-1 text-2xl font-semibold ${warn ? 'text-red-300' : 'text-slate-100'}`}>{value}</div>
    </div>
  );
}
