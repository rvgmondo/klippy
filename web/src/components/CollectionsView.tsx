import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, AlertTriangle, FileText, MessageCircle } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { ErrorNote } from './ErrorNote';
import { StatementView } from './StatementView';
import type { BusinessSelection } from './BusinessSwitcher';
import { money } from '../lib/money';
import { notify } from './ConfirmDialog';

interface Item {
  id: number; number: string; clientName: string; clientEmail: string | null;
  /** A phone is on the client or one of its contacts: WhatsApp works. */
  hasPhone: boolean;
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

  // Which rows are ticked. Chasing sends ONE email per client per currency listing
  // everything they owe, with a pay link per invoice and their statement attached,
  // then records the reminder so the automatic schedule does not chase again today.
  const [sel, setSel] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setSel((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Click-to-chat: opens WhatsApp with the reminder already typed, pay link and
  // all. The founder's own phone does the sending; nothing to configure.
  const whatsapp = async (id: number) => {
    try {
      const r = await apiGet<{ url: string }>(`/documents/${id}/whatsapp-link`);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not build the WhatsApp link.', 'error');
    }
  };

  const chase = useMutation({
    mutationFn: (ids?: number[]) => apiPost<{ sent: number; covered: number; skipped: number }>(
      '/collections/chase',
      { ...(ids?.length ? { ids } : {}), ...(businessId === 'all' ? {} : { businessId }) }),
    onSuccess: (r) => {
      setSel(new Set());
      qc.invalidateQueries({ queryKey: ['collections'] });
      if (r.sent === 0) {
        notify('Nothing sent. No overdue invoice with an email address matched.', 'error');
      } else {
        const emails = r.sent === 1 ? '1 email' : `${r.sent} emails`;
        const invoices = r.covered === 1 ? '1 invoice' : `${r.covered} invoices`;
        notify(`Sent ${emails} covering ${invoices}${r.skipped ? `. ${r.skipped} skipped for having no email address` : ''}.`);
      }
    },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not send.', 'error'),
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
              <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  {sel.size > 0
                    ? `${sel.size} selected`
                    : 'Tick invoices to chase a few, or chase everything owed in one go.'}
                </div>
                <button onClick={() => chase.mutate(sel.size ? [...sel] : undefined)} disabled={chase.isPending}
                  className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-50">
                  <Mail size={14} /> {chase.isPending ? 'Sending' : sel.size ? `Chase selected (${sel.size})` : 'Chase all'}
                </button>
              </div>
              <div className="hidden overflow-x-auto rounded-xl border border-slate-800 sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="w-8 px-3 py-2">
                        <input type="checkbox" aria-label="Select every invoice with an email address"
                          checked={sel.size > 0 && sel.size === data.items.filter((i) => i.clientEmail).length}
                          onChange={(e) => setSel(e.target.checked
                            ? new Set(data.items.filter((i) => i.clientEmail).map((i) => i.id))
                            : new Set())}
                          className="accent-violet-500" />
                      </th>
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
                          <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)}
                            disabled={!i.clientEmail}
                            aria-label={`Select invoice ${i.number}`}
                            title={i.clientEmail ? undefined : 'No email address on this invoice'}
                            className="accent-violet-500 disabled:opacity-30" />
                        </td>
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
                            {i.hasPhone && (
                              <button onClick={() => whatsapp(i.id)}
                                title="Open WhatsApp with the reminder written, ready to send from your phone"
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">
                                <MessageCircle size={12} /> WhatsApp
                              </button>
                            )}
                            {i.clientEmail && (
                              <button onClick={() => chase.mutate([i.id])} disabled={chase.isPending}
                                title="Email an overdue notice for this invoice now, statement attached"
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                                <Mail size={12} /> Chase
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Cards for phones: chasing debtors is exactly the job done from a
                  phone in a spare minute, and the seven-column table made it a
                  zoom-and-squint exercise. */}
              <div className="overflow-hidden rounded-xl border border-slate-800 sm:hidden">
                {data.items.map((i) => (
                  <div key={i.id} className="border-t border-slate-800 px-3 py-3 first:border-t-0">
                    <div className="flex items-start gap-3">
                      <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)}
                        disabled={!i.clientEmail}
                        aria-label={`Select invoice ${i.number}`}
                        className="mt-1 accent-violet-500 disabled:opacity-30" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="num font-medium text-slate-200">{i.number}</span>
                          {i.suspended && (
                            <span className="flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                              <AlertTriangle size={10} /> At risk
                            </span>
                          )}
                        </div>
                        <div className="truncate text-sm text-slate-400">{i.clientName}</div>
                        <div className="num mt-0.5 text-[11px] text-slate-500">
                          <span className={i.daysOverdue >= 14 ? 'text-red-300' : 'text-amber-300'}>{i.daysOverdue}d overdue</span>
                          {', last reminder '}{i.lastReminderOn ?? 'never'}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="num font-semibold text-slate-100">{money(i.outstanding, i.currency)}</div>
                        {Math.abs(i.outstanding - i.total) > 0.005 && (
                          <div className="num text-[10px] text-slate-500">of {money(i.total, i.currency)}</div>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex justify-end gap-2">
                      {i.folderId && (
                        <button onClick={() => setStatementFor(i.folderId)}
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 hover:bg-slate-800">
                          <FileText size={13} /> Statement
                        </button>
                      )}
                      {i.hasPhone && (
                        <button onClick={() => whatsapp(i.id)}
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 hover:bg-slate-800">
                          <MessageCircle size={13} /> WhatsApp
                        </button>
                      )}
                      {i.clientEmail && (
                        <button onClick={() => chase.mutate([i.id])} disabled={chase.isPending}
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                          <Mail size={13} /> Chase
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              </>
            )}
            <p className="text-[11px] text-slate-500">
              WhatsApp opens a message on your own phone with the reminder and pay link written; you tap send.
              Chasing sends one email per client per currency listing everything owed, with a pay link for each invoice
              and their statement attached (and the same by SMS or WhatsApp when those are on under Settings). It also counts as the reminder, so the automatic schedule will not chase the
              same invoice again today. Reminders still send on each business's schedule, set in Business settings.
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
