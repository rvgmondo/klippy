import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, AlertTriangle, FileText } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { ErrorNote } from './ErrorNote';
import { StatementView } from './StatementView';
import type { BusinessSelection } from './BusinessSwitcher';
import { money } from '../lib/money';

interface Item {
  id: number; number: string; clientName: string; clientEmail: string | null;
  businessId: number | null; folderId: number | null; currency: string; total: number; outstanding: number; dueDate: string | null;
  daysOverdue: number; lastReminderOn: string | null; suspended: boolean;
}
interface Collections {
  items: Item[];
  summary: {
    count: number;
    /** One total per currency. Klippy never adds unlike currencies together. */
    byCurrency: { currency: string; outstanding: number; count: number }[];
    suspended: number;
  };
}


/**
 * Who owes money and needs chasing. Overdue unpaid invoices, worst first, with the
 * ones the schedule has flagged as at-risk called out. Reminders go out on their own,
 * so this is the place to see the state and nudge one by hand if needed.
 */
export function CollectionsView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const [statementFor, setStatementFor] = useState<number | null>(null);
  const bizQ = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data, error, refetch } = useQuery({
    queryKey: ['collections', businessId],
    queryFn: () => apiGet<Collections>(`/collections${bizQ}`),
    retry: false,
  });

  const remind = useMutation({
    mutationFn: (id: number) => apiPost(`/documents/${id}/email`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collections'] }),
  });

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-100">Collections</h1>
          <p className="mt-0.5 text-sm text-slate-500">Overdue invoices, and who has been flagged for non-payment.</p>
        </div>

        {error && <ErrorNote error={error} onRetry={() => refetch()} />}

        {data && (
          <>
            {/* One "Outstanding" tile per currency. The old single tile added every
                overdue invoice together and labelled the result with whichever
                currency happened to be first in the list, which for a workspace
                billing in two currencies was simply a wrong number. */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {(data.summary.byCurrency.length ? data.summary.byCurrency : [{ currency: 'ZAR', outstanding: 0, count: 0 }])
                .map((c) => (
                  <Kpi key={c.currency}
                    label={data.summary.byCurrency.length > 1 ? `Outstanding (${c.currency})` : 'Outstanding'}
                    value={money(c.outstanding, c.currency)} />
                ))}
              <Kpi label="Overdue invoices" value={String(data.summary.count)} />
              <Kpi label="Flagged at risk" value={String(data.summary.suspended)} warn={data.summary.suspended > 0} />
            </div>

            {data.items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
                Nothing overdue. Everyone has paid, or is not late yet.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2">Invoice</th>
                      <th className="px-3 py-2">Client</th>
                      <th className="px-3 py-2 text-right">Outstanding</th>
                      <th className="px-3 py-2 text-right">Overdue</th>
                      <th className="px-3 py-2">Last reminder</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((i) => (
                      <tr key={i.id} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="num text-slate-200">{i.number}</span>
                            {i.suspended && (
                              <span className="flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                                <AlertTriangle size={10} /> At risk
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="text-slate-200">{i.clientName}</div>
                          {i.clientEmail && <div className="text-[11px] text-slate-500">{i.clientEmail}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-right num text-slate-100">
                          {money(i.outstanding, i.currency)}
                          {Math.abs(i.outstanding - i.total) > 0.005 && (
                            <div className="text-[10px] text-slate-500">of {money(i.total, i.currency)}</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right num">
                          <span className={i.daysOverdue >= 14 ? 'text-red-300' : 'text-amber-300'}>{i.daysOverdue}d</span>
                        </td>
                        <td className="px-3 py-2.5 num text-[11px] text-slate-500">{i.lastReminderOn ?? 'never'}</td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex justify-end gap-1.5">
                            {i.folderId && (
                              <button onClick={() => setStatementFor(i.folderId)}
                                title="Statement of account for this client"
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">
                                <FileText size={12} /> Statement
                              </button>
                            )}
                            {i.clientEmail && (
                              <button onClick={() => remind.mutate(i.id)} disabled={remind.isPending}
                                title="Email this invoice again now"
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                                <Mail size={12} /> Nudge
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-slate-500">
              Reminders send automatically on each business's schedule (set in Business settings). "Nudge" re-sends the invoice now.
            </p>
          </>
        )}
      </div>
      {statementFor && <StatementView folderId={statementFor} onClose={() => setStatementFor(null)} />}
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
