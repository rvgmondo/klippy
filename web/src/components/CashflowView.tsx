import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { navigateTo } from '../lib/urlAction';
import { apiGet } from '../lib/api';
import { ErrorNote } from './ErrorNote';
import type { BusinessSelection } from './BusinessSwitcher';
import { money } from '../lib/money';
import { SkeletonTile } from './ui';
import { Page, PageHeader, PageBody } from './PageHeader';

interface Bucket { start: string; end: string; invoices: number; subscriptions: number; total: number }
interface Lane {
  currency: string;
  overdue: number; overdueCount: number;
  /** Invoices due beyond the eight weeks shown. */
  later: number;
  buckets: Bucket[];
  expected: number;
  /** Invoices not sent yet: cannot arrive until they are. */
  drafts?: number; draftCount?: number;
  /** What makes up each column. week -1 is overdue, 8 is after the eight weeks. */
  items?: { week: number; kind: 'invoice' | 'subscription'; id: number; label: string; client: string; date: string; amount: number }[];
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
    <Page>
      <PageHeader view="cashflow" title="Coming in"
        subtitle="What should arrive over the next eight weeks, from invoices already out and subscriptions still to bill." />
      <PageBody className="space-y-6">
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
      </PageBody>
    </Page>
  );
}

function CurrencyLane({ lane, many }: { lane: Lane; many: boolean }) {
  const peak = Math.max(...lane.buckets.map((b) => b.total), lane.overdue, 1);
  // Which column is open underneath. The chart shows the shape; this says whose
  // money it is, which is what you need before ringing anyone.
  const [week, setWeek] = useState<number | null>(null);
  const due8 = lane.buckets.reduce((t, b) => t + b.total, 0);
  const picked = week == null ? [] : (lane.items ?? []).filter((i) => i.week === week);
  const pickedLabel = week === -1 ? 'Already overdue' : week === lane.buckets.length ? 'Due after the eight weeks'
    : week != null ? `Week of ${shortDate(lane.buckets[week]!.start)}` : '';
  const pick = (w: number) => setWeek((cur) => (cur === w ? null : w));

  return (
    <section className="space-y-4">
      {many && <h2 className="text-sm font-semibold text-slate-300">{lane.currency}</h2>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {/* Due and overdue are separate figures. The first tile used to include the
            overdue money as well, so the same rand was shown twice side by side. */}
        <Kpi label={`Due in the next 8 weeks${many ? ` (${lane.currency})` : ''}`} value={money(due8, lane.currency)} />
        <Kpi label={`Already overdue${lane.overdueCount ? ` (${lane.overdueCount})` : ''}`}
          value={money(lane.overdue, lane.currency)} warn={lane.overdue > 0} />
        <Kpi label="Due after that" value={money(lane.later, lane.currency)} />
      </div>

      {(lane.drafts ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-amber-100">
            <span className="num font-semibold">{money(lane.drafts!, lane.currency)}</span> is sitting in {lane.draftCount} draft
            invoice{lane.draftCount === 1 ? '' : 's'}. None of it can come in until it is sent.
          </p>
          <button onClick={() => navigateTo('billing')}
            className="min-h-10 rounded-lg border border-amber-500/40 px-3 text-sm text-amber-100 hover:bg-amber-500/15 sm:min-h-9">
            Open invoices
          </button>
        </div>
      )}

      {/* One column per week, invoices and subscriptions stacked. Bars, because the
          question is "which weeks are thin", and a table hides that shape. */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        {/* Nine columns cannot shrink to a phone; the chart keeps its readable
            width and scrolls sideways instead, overdue column first in view. */}
        <div className="overflow-x-auto">
        <div className="grid min-w-[560px] grid-cols-9 gap-2 sm:min-w-0">
          <BarColumn label="Overdue" value={lane.overdue} peak={peak} currency={lane.currency}
            active={week === -1} onPick={() => pick(-1)}
            segments={[{ amount: lane.overdue, className: 'bg-red-500/70' }]} />
          {lane.buckets.map((b, i) => (
            <BarColumn key={b.start} label={shortDate(b.start)} value={b.total} peak={peak} currency={lane.currency}
              active={week === i} onPick={() => pick(i)}
              segments={[
                { amount: b.invoices, className: 'bg-violet-500/80' },
                { amount: b.subscriptions, className: 'bg-sky-500/70' },
              ]} />
          ))}
        </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-violet-500/80" /> Invoices due</span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-sky-500/70" /> Subscriptions billing</span>
          <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-red-500/70" /> Overdue</span>
          {lane.later > 0 && (
            <button onClick={() => pick(lane.buckets.length)} className="text-violet-300 hover:underline">
              See what is due after that
            </button>
          )}
          <span className="ml-auto">Tap a week to see what is in it.</span>
        </div>

        {week != null && (
          <div className="mt-4 border-t border-slate-800 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">{pickedLabel}</span>
              <button onClick={() => setWeek(null)} className="text-[11px] text-slate-500 hover:text-slate-300">Close</button>
            </div>
            {picked.length === 0 ? (
              <p className="text-xs text-slate-500">Nothing due in this week.</p>
            ) : (
              <div className="space-y-0.5">
                {picked.map((i) => (
                  <button key={`${i.kind}${i.id}${i.date}`}
                    onClick={() => i.kind === 'invoice' ? navigateTo('billing', { open: String(i.id), doctype: 'invoice' }) : navigateTo('subscriptions')}
                    className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-800/60">
                    <span className={`h-2 w-2 shrink-0 self-center rounded-sm ${i.kind === 'invoice' ? (week === -1 ? 'bg-red-500/70' : 'bg-violet-500/80') : 'bg-sky-500/70'}`} />
                    <span className="min-w-0 flex-1 truncate text-slate-200">{i.client || 'No client'}</span>
                    <span className="hidden truncate text-slate-500 sm:inline">{i.label}</span>
                    <span className="num shrink-0 text-slate-500">{shortDate(i.date)}</span>
                    <span className="num w-24 shrink-0 text-right text-slate-100">{money(i.amount, lane.currency)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function BarColumn({ label, value, peak, currency, segments, active, onPick }: {
  label: string; value: number; peak: number; currency: string;
  segments: { amount: number; className: string }[];
  active?: boolean; onPick?: () => void;
}) {
  return (
    <button type="button" onClick={onPick} aria-pressed={active}
      aria-label={`${label}: ${value > 0 ? money(value, currency) : 'nothing'}`}
      className={`flex flex-col items-center gap-1.5 rounded-lg py-1 ${active ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'}`}
      title={value > 0 ? money(value, currency) : 'Nothing'}>
      <div className="num text-[10px] text-slate-400">{value > 0 ? money(value, currency) : ''}</div>
      <div className="flex h-28 w-full max-w-10 flex-col justify-end gap-px overflow-hidden rounded-t">
        {segments.filter((s) => s.amount > 0).map((s, i) => (
          <div key={i} className={s.className} style={{ height: `${Math.max(3, (s.amount / peak) * 100)}%` }} />
        ))}
      </div>
      <div className="border-t border-slate-700 pt-1 text-[10px] text-slate-500">{label}</div>
    </button>
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
