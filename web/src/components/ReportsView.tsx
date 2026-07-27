import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import type { BusinessSelection } from './BusinessSwitcher';

interface ClientRow {
  folderId: number; name: string; hours: number; rate: number | null; amount: number | null;
}
interface Report {
  currency: string;
  clients: ClientRow[];
  people: { userId: number; name: string; hours: number }[];
  totals: { hours: number; amount: number; unratedClients: number };
}

function money(v: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(v); }
  catch { return `${currency} ${v.toFixed(2)}`; }
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

  const { data, isLoading } = useQuery({
    queryKey: ['report', from, to, businessId],
    queryFn: () => apiGet<Report>(`/reports/time?from=${from}&to=${to}${bizQ}`),
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

        {isLoading || !data ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Tile label="Total time" value={`${data.totals.hours.toFixed(2)} h`} />
              <Tile label="Billable" value={money(data.totals.amount, cur)} accent />
              <Tile label="Clients without a rate" value={String(data.totals.unratedClients)} />
            </div>

            <h3 className="mb-2 text-sm font-semibold text-slate-300">By client</h3>
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 text-right font-medium">Hours</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-500">No time tracked in this range.</td></tr>
                  )}
                  {data.clients.map((c) => (
                    <tr key={c.folderId} className="border-t border-slate-800">
                      <td className="px-3 py-2 text-slate-200">{c.name}</td>
                      <td className="px-3 py-2 text-right num text-slate-300">{c.hours.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right num text-slate-400">
                        {c.rate == null ? <span className="text-amber-400/80">no rate</span> : money(c.rate, cur)}
                      </td>
                      <td className="px-3 py-2 text-right num text-slate-100">
                        {c.amount == null ? '-' : money(c.amount, cur)}
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
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-1 text-xs text-slate-400">{label}</div>
      <div className={`num text-2xl font-semibold ${accent ? 'text-violet-300' : 'text-slate-100'}`}>{value}</div>
    </div>
  );
}
