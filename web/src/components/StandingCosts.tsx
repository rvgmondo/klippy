import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Repeat, Plus, X } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import { fieldClass, btnPrimary, btnSecondary } from './ui';
import { notify, confirmDialog } from './ConfirmDialog';
import { money as fmt } from '../lib/money';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * The costs that repeat.
 *
 * Rent, salaries, software, insurance. Klippy only had one-off expenses, so these had
 * to be typed in again every month or they never appeared at all. Nobody does that
 * twelve times a year, which meant the spending side of every report was understated
 * and profit read better than the bank did.
 *
 * It lives on the Expenses screen rather than in a settings page because it is the
 * same subject: one is a cost that happened, this is a cost that keeps happening. What
 * every report reads is still the ordinary expense rows this writes.
 */

interface Recurring {
  id: number; businessId: number; description: string; category: string | null;
  amount: string; intervalMonths: number;
  nextDueOn: string; startedOn: string; endsOn: string | null; isActive: boolean;
}

const EVERY: Record<number, string> = { 1: 'Every month', 3: 'Every quarter', 6: 'Twice a year', 12: 'Once a year' };
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function StandingCosts({ businessId, currency }: { businessId: BusinessSelection; currency: string }) {
  const qc = useQueryClient();
  const money = (v: string | number) => fmt(v, currency);
  const [adding, setAdding] = useState(false);
  const bid = businessId === 'all' ? null : Number(businessId);
  const [draft, setDraft] = useState({
    description: '', category: '', amount: '', intervalMonths: '1', startedOn: iso(new Date()),
  });

  const { data } = useQuery({
    queryKey: ['recurring-expenses'],
    queryFn: () => apiGet<{ recurring: Recurring[] }>('/recurring-expenses'),
  });
  const rows = (data?.recurring ?? []).filter((r) => bid == null || r.businessId === bid);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['recurring-expenses'] });
    qc.invalidateQueries({ queryKey: ['expenses'] });
  };

  const add = useMutation({
    mutationFn: (v: Record<string, unknown>) => apiPost<{ recorded: number }>('/recurring-expenses', v),
    onSuccess: (r) => {
      setAdding(false);
      setDraft({ description: '', category: '', amount: '', intervalMonths: '1', startedOn: iso(new Date()) });
      invalidate();
      // Say how many months it just filled in. A cost entered late records the months
      // it has already been running, and that is surprising unless it is stated.
      notify(r.recorded > 0
        ? `Added, and ${r.recorded} ${r.recorded === 1 ? 'month was' : 'months were'} recorded.`
        : 'Added. It will be recorded when it next falls due.', 'ok');
    },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const stop = useMutation({
    mutationFn: (id: number) => apiDelete<{ message?: string }>(`/recurring-expenses/${id}`),
    onSuccess: (r) => { invalidate(); notify(r?.message ?? 'Stopped.', 'ok'); },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const monthlyEquivalent = rows
    .filter((r) => r.isActive)
    .reduce((sum, r) => sum + Number(r.amount) / Math.max(1, r.intervalMonths), 0);

  return (
    <div className="mb-5 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Repeat size={15} className="text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-200">Costs that repeat</h3>
        {monthlyEquivalent > 0 && (
          <span className="text-xs text-slate-500">
            about <span className="num text-slate-300">{money(monthlyEquivalent)}</span> a month
          </span>
        )}
        <div className="flex-1" />
        {bid && !adding && (
          <button onClick={() => setAdding(true)} className={btnSecondary + ' flex items-center gap-1.5'}>
            <Plus size={14} /> Add one
          </button>
        )}
      </div>

      {rows.length === 0 && !adding && (
        <p className="text-xs text-slate-500">
          {bid
            ? 'Rent, salaries, software, insurance. Record one here and it gets logged every month on its own, so your spending stays right without you retyping it.'
            : 'Pick one business above to set up the costs that repeat.'}
        </p>
      )}

      {rows.length > 0 && (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.id} className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm ${
              r.isActive ? '' : 'opacity-50'}`}>
              <span className="min-w-0 flex-1 truncate text-slate-300">
                {r.description}
                {r.category && <span className="ml-2 text-[11px] text-slate-500">{r.category}</span>}
              </span>
              <span className="shrink-0 text-[11px] text-slate-500">
                {EVERY[r.intervalMonths] ?? `Every ${r.intervalMonths} months`}
                {r.isActive
                  ? <>, next <span className="num">{r.nextDueOn.slice(0, 10)}</span></>
                  : ', stopped'}
              </span>
              <span className="num shrink-0 text-slate-100">{money(r.amount)}</span>
              <button
                onClick={async () => {
                  const yes = await confirmDialog(
                    `Stop recording ${r.description}? It stops from now on. Everything it has already recorded is kept, because that money really did leave the business.`,
                    { confirmLabel: 'Stop it' });
                  if (yes) stop.mutate(r.id);
                }}
                title="Stop this cost"
                className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && bid && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const amount = Number(draft.amount);
            if (!draft.description.trim() || !(amount > 0)) return;
            add.mutate({
              businessId: bid,
              description: draft.description.trim(),
              category: draft.category.trim() || null,
              amount,
              intervalMonths: Number(draft.intervalMonths),
              startedOn: draft.startedOn,
            });
          }}
          className="mt-3 grid gap-2 border-t border-slate-800 pt-3 sm:grid-cols-5">
          <input className={fieldClass} placeholder="What is it for" required value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} autoFocus />
          <input className={fieldClass} placeholder="Category" value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          <input className={fieldClass} type="number" step="0.01" min="0" required placeholder="Amount"
            value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
          <select className={fieldClass} value={draft.intervalMonths}
            onChange={(e) => setDraft({ ...draft, intervalMonths: e.target.value })}>
            {Object.entries(EVERY).map(([m, label]) => <option key={m} value={m}>{label}</option>)}
          </select>
          <div className="flex gap-2">
            <input className={fieldClass} type="date" required value={draft.startedOn}
              onChange={(e) => setDraft({ ...draft, startedOn: e.target.value })} />
            <button type="submit" disabled={add.isPending} className={btnPrimary}>Add</button>
          </div>
          <p className="text-[11px] text-slate-500 sm:col-span-5">
            Set the date it actually started, even if that was months ago. Klippy records
            every month since, so your past spending is right too.
          </p>
        </form>
      )}
    </div>
  );
}
