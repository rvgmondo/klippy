import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, X } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import { Modal } from './Modal';
import { promptDialog } from './ConfirmDialog';
import { money, type DocSummary } from './billingShared';
import { fieldInlineClass } from './ui';

interface Payment { id: number; amount: string; paidOn: string; method: string | null; note: string | null }
interface Credit { id: number; number: string; total: string; issueDate: string; notes: string | null }

const todayStr = () => new Date().toISOString().slice(0, 10);

export function PaymentsModal({ doc, onClose }: { doc: DocSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ['payments', doc.id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiGet<{
      payments: Payment[]; credits: Credit[]; paid: number; credited: number; outstanding: number; total: number;
    }>(`/documents/${doc.id}/payments`),
  });
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(todayStr());
  const [method, setMethod] = useState('');
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['documents'] });
    qc.invalidateQueries({ queryKey: ['collections'] });
    // A statement is the same money seen another way; recording a payment behind
    // an open statement used to leave it showing the old balance.
    qc.invalidateQueries({ queryKey: ['statement'] });
  };
  const add = useMutation({
    mutationFn: () => apiPost(`/documents/${doc.id}/payments`, { amount: Number(amount), paidOn, method: method.trim() || null }),
    onSuccess: () => { setAmount(''); setMethod(''); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/payments/${id}`), onSuccess: invalidate });
  // Cancelling or reducing an issued invoice is a credit note, never an edit, so
  // the client's copy and yours still agree.
  const credit = useMutation({
    mutationFn: (reason: string) => apiPost(`/documents/${doc.id}/credit-note`, { reason: reason || undefined }),
    onSuccess: invalidate,
  });
  const field = fieldInlineClass;

  return (
    <Modal onClose={onClose} size="sm" labelledBy="payments-title">
      <div className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="payments-title" className="font-display text-lg font-semibold text-slate-100">Payments for {doc.number}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className={`mb-4 grid gap-2 text-center ${(data?.credited ?? 0) > 0 ? 'grid-cols-4' : 'grid-cols-3'}`}>
          <div className="rounded-lg border border-slate-800 py-2"><div className="text-[11px] text-slate-500">Total</div><div className="text-sm font-medium text-slate-200">{money(data?.total ?? doc.total, doc.currency)}</div></div>
          <div className="rounded-lg border border-slate-800 py-2"><div className="text-[11px] text-slate-500">Paid</div><div className="text-sm font-medium text-green-400">{money(data?.paid ?? 0, doc.currency)}</div></div>
          {(data?.credited ?? 0) > 0 && (
            <div className="rounded-lg border border-slate-800 py-2"><div className="text-[11px] text-slate-500">Credited</div><div className="text-sm font-medium text-sky-400">{money(data?.credited ?? 0, doc.currency)}</div></div>
          )}
          <div className="rounded-lg border border-slate-800 py-2"><div className="text-[11px] text-slate-500">Outstanding</div><div className="text-sm font-medium text-amber-400">{money(data?.outstanding ?? 0, doc.currency)}</div></div>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          <input className={field + ' w-24'} type="number" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className={field} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          <input className={field + ' w-24'} placeholder="Method" value={method} onChange={(e) => setMethod(e.target.value)} />
          <button onClick={() => Number(amount) !== 0 && add.mutate()} disabled={!(Number(amount) !== 0)}
            className="rounded-lg bg-violet-600 px-3 py-2 text-sm text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">Record</button>
        </div>
        <p className="mb-3 text-[11px] text-slate-500">Enter a negative amount to record a refund.</p>

        <div className="space-y-1">
          {(data?.payments ?? []).length === 0 && <p className="text-sm text-slate-500">No payments recorded.</p>}
          {(data?.payments ?? []).map((p) => (
            <div key={p.id} className="group flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-1.5 text-sm">
              <span className="text-slate-300">{p.paidOn}</span>
              <span className="text-slate-500">{p.method}</span>
              <span className={`ml-auto num ${Number(p.amount) < 0 ? 'text-rose-300' : 'text-slate-200'}`}>
                {Number(p.amount) < 0 ? `Refund ${money(Math.abs(Number(p.amount)), doc.currency)}` : money(p.amount, doc.currency)}
              </span>
              <button onClick={() => del.mutate(p.id)} className="text-slate-500 hover:text-red-400"><Trash2 size={13} /></button>
            </div>
          ))}
          {(data?.credits ?? []).map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-1.5 text-sm">
              <span className="num text-sky-300">{c.number}</span>
              <span className="truncate text-[11px] text-slate-500">{c.notes}</span>
              <span className="ml-auto num text-sky-300">-{money(c.total, doc.currency)}</span>
            </div>
          ))}
        </div>

        {/* Credit notes only apply to invoices, and only while something is owed. */}
        {doc.type === 'invoice' && (data?.outstanding ?? 0) > 0.005 && (
          <button
            onClick={async () => {
              const reason = await promptDialog(`Credit the remaining ${money(data?.outstanding ?? 0, doc.currency)} on ${doc.number}?\n\nReason (optional):`);
              if (reason !== null) credit.mutate(reason.trim());
            }}
            disabled={credit.isPending}
            className="mt-3 w-full rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-60">
            {credit.isPending ? 'Raising...' : 'Raise a credit note for the balance'}
          </button>
        )}
        {credit.error && <p className="mt-2 text-[11px] text-red-400">{(credit.error as Error).message}</p>}
      </div>
    </Modal>
  );
}
