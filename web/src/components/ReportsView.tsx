import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import type { BusinessSelection } from './BusinessSwitcher';
import { ErrorNote } from './ErrorNote';
import { money } from '../lib/money';

interface ClientRow {
  folderId: number; name: string; hours: number; rate: number | null; amount: number | null;
  cost: number; profit: number | null;
  /** The currency this client's business bills in. */
  currency: string;
}
interface CurrencyTotals {
  currency: string; billable: number; expenses: number; profit: number; mrr: number;
}
interface Report {
  currency: string;
  /** The money split by currency. Klippy never converts, so this is the truth. */
  byCurrency: CurrencyTotals[];
  /** True when the businesses in range do not share a currency. */
  mixed: boolean;
  clients: ClientRow[];
  people: { userId: number; name: string; hours: number }[];
  totals: { hours: number; amount: number; unratedClients: number; expenses: number; profit: number; mrr: number };
}


function startOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function today() { return new Date().toISOString().slice(0, 10); }

export function ReportsView({ businessId }: { businessId: BusinessSelection }) {
  const [from, setFrom] = useState(startOfMonth());
  const [to, setTo] = useState(today());
  const bizQ = businessId === 'all' ? '' : `&businessId=${businessId}`;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['report', from, to, businessId],
    queryFn: () => apiGet<Report>(`/reports/time?from=${from}&to=${to}${bizQ}`),
    retry: false,
  });
  const vat = useQuery({
    queryKey: ['vat', from, to],
    queryFn: () => apiGet<{
      currency: string;
      output: { currency: string; sales: number; outputVat: number }[];
      inputVat: number; netPayable: number;
    }>(`/reports/vat?from=${from}&to=${to}`),
    retry: false,
  });

  const field = 'rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500';
  const cur = data?.currency ?? 'ZAR';

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <h2 className="mr-auto font-display text-lg font-semibold text-slate-100">Time &amp; billing</h2>
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">From</label>
            <input type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">To</label>
            <input type="date" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>

        {/* For the bookkeeper: VAT for the period and one-click CSV exports. The data
            always existed; it just could not leave the app. */}
        <div className="mb-5 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold text-slate-200">For your accountant</h3>
            {(['invoices', 'payments', 'expenses'] as const).map((k) => (
              <a key={k} href={`/api/v1/reports/export?kind=${k}&from=${from}&to=${to}`}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                Export {k} CSV
              </a>
            ))}
          </div>
          {vat.data && (
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              {vat.data.output.length === 0 ? (
                <span className="text-slate-500">No sales VAT in this period.</span>
              ) : vat.data.output.map((o) => (
                <div key={o.currency}>
                  <span className="text-slate-500">Output VAT ({o.currency}): </span>
                  <span className="num text-slate-100">{money(o.outputVat, o.currency)}</span>
                </div>
              ))}
              <div>
                <span className="text-slate-500">Input VAT ({vat.data.currency}): </span>
                <span className="num text-slate-100">{money(vat.data.inputVat, vat.data.currency)}</span>
              </div>
              <div>
                <span className="text-slate-500">Net VAT payable ({vat.data.currency}): </span>
                <span className="num font-semibold text-slate-100">{money(vat.data.netPayable, vat.data.currency)}</span>
              </div>
            </div>
          )}
        </div>

        {error ? (
          // Without this the page sat on "Loading..." forever whenever the request
          // failed, which looks like the report is simply broken.
          <ErrorNote error={error} onRetry={() => refetch()} />
        ) : isLoading || !data ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Tile label="Total time" value={`${data.totals.hours.toFixed(2)} h`} />
              {/* With one currency these read as before. With several, adding them
                  would produce a number that is not money in any currency, so each
                  gets its own row instead and nothing is converted. */}
              {data.mixed ? (
                <Tile label="Billable" value={`${data.byCurrency.length} currencies`}
                  hint={data.byCurrency.map((b) => money(b.billable, b.currency)).join('  |  ')} />
              ) : (
                <>
                  <Tile label="Billable" value={money(data.totals.amount, cur)} accent />
                  <Tile label="Expenses" value={money(data.totals.expenses, cur)} />
                  <Tile label="Profit" value={money(data.totals.profit, cur)} accent={data.totals.profit >= 0} warn={data.totals.profit < 0} />
                </>
              )}
              <Tile label="Clients without a rate" value={String(data.totals.unratedClients)} />
            </div>
            {data.mixed && (
              <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2">Currency</th>
                      <th className="px-3 py-2 text-right">Billable</th>
                      <th className="px-3 py-2 text-right">Expenses</th>
                      <th className="px-3 py-2 text-right">Profit</th>
                      <th className="px-3 py-2 text-right">MRR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byCurrency.map((b) => (
                      <tr key={b.currency} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-3 py-2 font-medium text-slate-200">{b.currency}</td>
                        <td className="px-3 py-2 text-right num text-slate-100">{money(b.billable, b.currency)}</td>
                        <td className="px-3 py-2 text-right num text-slate-400">{money(b.expenses, b.currency)}</td>
                        <td className={`px-3 py-2 text-right num ${b.profit < 0 ? 'text-red-300' : 'text-slate-100'}`}>{money(b.profit, b.currency)}</td>
                        <td className="px-3 py-2 text-right num text-violet-300">{money(b.mrr, b.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-500">
                  Not converted. Klippy reports each currency as it was billed.
                </p>
              </div>
            )}

            {!data.mixed && data.totals.mrr > 0 && (
              <p className="-mt-3 mb-5 text-xs text-slate-500">
                Plus <span className="font-medium text-violet-300">{money(data.totals.mrr, cur)}</span> in monthly recurring revenue (not date-ranged - see Offerings).
              </p>
            )}

            <h3 className="mb-2 text-sm font-semibold text-slate-300">By client</h3>
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 text-right font-medium">Hours</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Cost</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No time tracked in this range.</td></tr>
                  )}
                  {data.clients.map((c) => (
                    <tr key={c.folderId} className="border-t border-slate-800">
                      <td className="px-3 py-2 text-slate-200">{c.name}</td>
                      <td className="px-3 py-2 text-right num text-slate-300">{c.hours.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right num text-slate-400">
                        {c.rate == null ? <span className="text-amber-400/80">no rate</span> : money(c.rate, cur)}
                      </td>
                      <td className="px-3 py-2 text-right num text-slate-100">
                        {c.amount == null ? '-' : money(c.amount, c.currency)}
                      </td>
                      <td className="hidden px-3 py-2 text-right num text-slate-400 sm:table-cell">
                        {c.cost > 0 ? money(c.cost, c.currency) : '-'}
                      </td>
                      <td className="hidden px-3 py-2 text-right num sm:table-cell">
                        {c.profit == null ? '-' : <span className={c.profit < 0 ? 'text-red-400' : 'text-slate-100'}>{money(c.profit, c.currency)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.totals.unratedClients > 0 && (
              <p className="mt-2 text-[11px] text-amber-400/80">
                Set an hourly rate on a client (its ⋯ menu in the sidebar) and its hours turn into money here.
                Rates flow down to subfolders.
              </p>
            )}

            <h3 className="mb-2 mt-6 text-sm font-semibold text-slate-300">By person</h3>
            <div className="space-y-1">
              {data.people.map((p) => (
                <div key={p.userId} className="flex items-center justify-between rounded-lg border border-slate-800 px-3 py-2">
                  <span className="text-sm text-slate-200">{p.name}</span>
                  <span className="num text-sm text-slate-300">{p.hours.toFixed(2)} h</span>
                </div>
              ))}
            </div>

            <EstimateAccuracy from={from} to={to} businessId={businessId} />
          </>
        )}
      </div>
    </div>
  );
}

interface EstimateRow {
  id: number; title: string; folderName: string | null; isCompleted: boolean;
  estimateMinutes: number; actualMinutes: number; diffMinutes: number; overPct: number | null;
}
interface EstimateReport {
  tasks: EstimateRow[];
  totals: { compared: number; estimateMinutes: number; actualMinutes: number; accuracyPct: number | null };
}

const dur = (m: number) => {
  const sign = m < 0 ? '-' : '';
  const a = Math.abs(m), h = Math.floor(a / 60), mm = a % 60;
  return h > 0 ? `${sign}${h}h${mm ? ` ${mm}m` : ''}` : `${sign}${mm}m`;
};

/**
 * Estimate vs actual. Only means anything once cards carry an estimate AND have had
 * the timer run on them, so it stays quiet until there is something real to compare.
 */
function EstimateAccuracy({ from, to, businessId }: { from: string; to: string; businessId: BusinessSelection }) {
  const bizQ = businessId === 'all' ? '' : `&businessId=${businessId}`;
  const { data, error } = useQuery({
    queryKey: ['estimates', from, to, businessId],
    queryFn: () => apiGet<EstimateReport>(`/reports/estimates?from=${from}&to=${to}${bizQ}`),
    retry: false,
  });
  if (error) {
    return (
      <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-300">
        Estimate vs actual could not load. {error instanceof Error ? error.message : ''}
      </div>
    );
  }
  if (!data || data.totals.compared === 0) {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-slate-700 p-4 text-sm text-slate-400">
        <span className="text-slate-200">Estimate vs actual</span> shows up here once cards have both an
        estimate and tracked time. Set estimates in <span className="text-slate-200">Today</span>, then run the
        timer while you work.
      </div>
    );
  }
  const { totals } = data;
  const over = (totals.accuracyPct ?? 0) > 0;
  return (
    <>
      <h3 className="mb-2 mt-6 text-sm font-semibold text-slate-300">Estimate vs actual</h3>
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Estimated" value={dur(totals.estimateMinutes)} />
        <Tile label="Actually took" value={dur(totals.actualMinutes)} />
        <Tile label={over ? 'Over by' : 'Under by'}
          value={`${Math.abs(totals.accuracyPct ?? 0)}%`} warn={over} accent={!over} />
      </div>
      <p className="mb-2 text-[11px] text-slate-500">
        Across {totals.compared} card{totals.compared === 1 ? '' : 's'} that had both an estimate and tracked time.
        {over
          ? ' Work is taking longer than planned, so pad future estimates and quotes.'
          : ' Work is coming in under estimate, so there is room to commit to more.'}
      </p>
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Card</th>
              <th className="px-3 py-2 text-right font-medium">Estimate</th>
              <th className="px-3 py-2 text-right font-medium">Actual</th>
              <th className="px-3 py-2 text-right font-medium">Diff</th>
            </tr>
          </thead>
          <tbody>
            {data.tasks.map((t) => (
              <tr key={t.id} className="border-t border-slate-800">
                <td className="px-3 py-2">
                  <div className="truncate text-slate-200">{t.title}</div>
                  {t.folderName && <div className="truncate text-[11px] text-slate-500">{t.folderName}</div>}
                </td>
                <td className="px-3 py-2 text-right num text-slate-400">{dur(t.estimateMinutes)}</td>
                <td className="px-3 py-2 text-right num text-slate-300">{dur(t.actualMinutes)}</td>
                <td className={`px-3 py-2 text-right num ${t.diffMinutes > 0 ? 'text-red-400' : 'text-violet-300'}`}>
                  {t.diffMinutes > 0 ? '+' : ''}{dur(t.diffMinutes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Tile({ label, value, accent, warn, hint }: { label: string; value: string; accent?: boolean; warn?: boolean; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-1 text-xs text-slate-400">{label}</div>
      <div className={`num text-2xl font-semibold ${warn ? 'text-red-400' : accent ? 'text-violet-300' : 'text-slate-100'}`}>{value}</div>
      {hint && <div className="mt-1 num text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}
