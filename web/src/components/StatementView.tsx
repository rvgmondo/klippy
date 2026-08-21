import { useState } from 'react';
import { Modal } from './Modal';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Mail, Printer, X } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { money } from '../lib/money';
import { notify } from './ConfirmDialog';
import { fieldCompactClass } from './ui';

interface Entry {
  date: string; kind: 'opening' | 'invoice' | 'credit_note' | 'payment' | 'refund';
  ref: string; detail: string | null; charge: number; credit: number; balance: number;
}
interface Statement {
  client: { id: number; name: string; businessId: number | null; billingEmail: string | null };
  from: string | null; to: string | null;
  /** The currency THIS statement is drawn in. A balance only means something in one. */
  currency: string;
  /** Every currency this client has been billed in, when there is more than one. */
  currencies: string[];
  entries: Entry[];
  summary: { opening: number; invoiced: number; credited: number; received: number; balance: number };
}


const KIND_LABEL: Record<Exclude<Entry['kind'], 'opening'>, string> = {
  invoice: 'Invoice', credit_note: 'Credit note', payment: 'Payment', refund: 'Refund',
};

/**
 * A client statement: what they were invoiced, what they were credited, what they
 * paid, and what is left, oldest first with a running balance. The answer to "what
 * do we actually owe you", on paper.
 */
export function StatementView({ folderId, onClose }: { folderId: number; onClose: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Blank means "whichever the server picks", which is the only currency for almost
  // every client. A running balance cannot span currencies, so this is a filter on
  // the statement rather than a display option.
  const [pick, setPick] = useState('');
  const qs = [from && `from=${from}`, to && `to=${to}`, pick && `currency=${pick}`].filter(Boolean).join('&');
  const { data } = useQuery({
    queryKey: ['statement', folderId, from, to, pick],
    queryFn: () => apiGet<Statement>(`/statements/${folderId}${qs ? `?${qs}` : ''}`),
  });

  const cur = data?.currency ?? 'ZAR';
  const others = data?.currencies ?? [];
  const field = fieldCompactClass;

  // The same statement, rendered server-side as a PDF and mailed to the client's
  // billing email. The server refuses politely when no billing email is set.
  const emailIt = useMutation({
    mutationFn: () => apiPost<{ ok: true; to: string }>(`/statements/${folderId}/email`, {
      ...(from ? { from } : {}), ...(to ? { to } : {}), ...(pick ? { currency: pick } : {}),
    }),
    onSuccess: (r) => notify(`Statement sent to ${r.to}.`),
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not send the statement.', 'error'),
  });

  return (
    <Modal onClose={onClose} variant="page">
      <div className="mx-auto my-4 max-w-3xl">
        <div className="no-print mb-3 flex flex-wrap items-center justify-end gap-2">
          <input type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
          <input type="date" className={field} value={to} onChange={(e) => setTo(e.target.value)} title="To" />
          {others.length > 1 && (
            <select className={field} value={pick || cur} onChange={(e) => setPick(e.target.value)}
              title="This client has been billed in more than one currency">
              {others.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <button onClick={() => emailIt.mutate()} disabled={emailIt.isPending}
            title={data?.client.billingEmail
              ? `Email this statement as a PDF to ${data.client.billingEmail}`
              : 'Set a billing email on the client first'}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">
            <Mail size={15} /> {emailIt.isPending ? 'Sending' : 'Email statement'}
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90">
            <Printer size={15} /> Print / Save as PDF
          </button>
          <button onClick={onClose} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">
            <X size={15} />
          </button>
        </div>

        <div className="print-area overflow-hidden rounded-xl bg-white p-8 text-slate-900 shadow-xl sm:p-10">
          <div className="mb-6 flex items-start justify-between gap-6">
            <div>
              <div className="text-xl font-bold">Statement of account</div>
              <div className="mt-1 text-sm text-slate-600">{data?.client.name}</div>
              {others.length > 1 && (
                <div className="mt-1 text-xs text-slate-500">
                  In {cur}. This client has also been billed in {others.filter((c) => c !== cur).join(', ')}.
                </div>
              )}
            </div>
            <div className="text-right text-xs text-slate-500">
              {(data?.from || data?.to)
                ? <div>{data?.from ?? 'the beginning'} to {data?.to ?? 'today'}</div>
                : <div>All activity</div>}
            </div>
          </div>

          {data && data.entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No invoices or payments in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-slate-300 text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="py-2">Date</th>
                    <th className="py-2">Reference</th>
                    <th className="py-2 text-right">Charge</th>
                    <th className="py-2 text-right">Credit</th>
                    <th className="py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.entries ?? []).map((e, i) => (e.kind === 'opening' ? (
                    /* Activity from before the chosen range, netted into one row.
                       Without it a ranged statement pretends the account started at
                       zero and its closing balance misstates what is owed. */
                    <tr key={i} className="border-b border-slate-200 bg-slate-50">
                      <td className="py-2 num text-slate-600">{e.date}</td>
                      <td className="py-2 font-medium text-slate-800">Balance brought forward</td>
                      <td className="py-2" />
                      <td className="py-2" />
                      <td className="py-2 text-right num font-semibold text-slate-900">{money(e.balance, cur)}</td>
                    </tr>
                  ) : (
                    <tr key={i} className="border-b border-slate-200">
                      <td className="py-2 num text-slate-600">{e.date}</td>
                      <td className="py-2">
                        <span className="num text-slate-800">{e.ref}</span>
                        <span className="ml-2 text-[11px] text-slate-500">{KIND_LABEL[e.kind]}{e.detail ? `, ${e.detail}` : ''}</span>
                      </td>
                      <td className="py-2 text-right num text-slate-700">{e.charge ? money(e.charge, cur) : ''}</td>
                      <td className="py-2 text-right num text-slate-700">{e.credit ? money(e.credit, cur) : ''}</td>
                      <td className="py-2 text-right num font-medium text-slate-900">{money(e.balance, cur)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}

          {data && (
            <div className="mt-6 flex justify-end">
              <div className="w-72 space-y-1.5 text-sm">
                {data.summary.opening !== 0 && (
                  <div className="flex justify-between"><span className="text-slate-500">Brought forward</span><span className="num">{money(data.summary.opening, cur)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-slate-500">Invoiced</span><span className="num">{money(data.summary.invoiced, cur)}</span></div>
                {data.summary.credited > 0 && (
                  <div className="flex justify-between"><span className="text-slate-500">Credited</span><span className="num">-{money(data.summary.credited, cur)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-slate-500">Received</span><span className="num">-{money(data.summary.received, cur)}</span></div>
                <div className="mt-1 flex justify-between border-t-2 border-slate-300 pt-2 text-base font-bold">
                  <span>Balance due</span><span className="num">{money(data.summary.balance, cur)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
