import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CreditCard, RefreshCw, Plus, Link2 } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { fieldClass, fieldInlineClass, btnPrimary, btnSecondary, Skeleton } from './ui';
import { ErrorNote } from './ErrorNote';
import { notify } from './ConfirmDialog';
import { money } from '../lib/money';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * Money taken over a counter, and what it actually cost to take.
 *
 * Klippy grew up around invoices, so a business that sells to walk-ins was
 * invisible to it: the revenue figures were the invoiced half only. This is the
 * other half.
 *
 * Three figures, always together. Gross is what the customer paid, fee is what the
 * card provider kept, net is what reached the bank. Showing only the gross is how a
 * shop ends up believing it is doing better than its bank balance says, so the fee
 * is never hidden behind a toggle.
 */

interface Sale {
  id: number; businessId: number; provider: string;
  source: string | null; terminal: string | null;
  occurredAt: string; currency: string;
  gross: string; fee: string; net: string; taxAmount: string;
  reference: string | null; status: string;
}
interface Totals {
  currency: string; count: number;
  gross: number; fee: number; net: number; outputVat: number;
}
interface Connection {
  id: number; businessId: number; provider: string; label: string | null;
  enabled: boolean; hasKey: boolean;
  lastSyncedAt: string | null; lastSyncedThrough: string | null; lastStatus: string | null;
  businessName: string | null;
}

/**
 * Money, in whatever currency the sale was actually taken in.
 *
 * The shared helper rather than a local one, so takings read the same as every other
 * figure in the app and Intl handles the currencies with no decimals. Never
 * converted and never summed across currencies: a rand and a dollar added together
 * is money in neither.
 */
const format = (n: number, currency: string) => money(n, currency);

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d); };

export function TakingsView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(iso(new Date()));
  const [connecting, setConnecting] = useState(false);
  const [key, setKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ gross: '', fee: '', reference: '', occurredAt: iso(new Date()) });

  const only = businessId === 'all' ? '' : `&businessId=${businessId}`;
  const sales = useQuery({
    queryKey: ['sales', from, to, businessId],
    queryFn: () => apiGet<{ sales: Sale[]; totals: Totals[] }>(`/sales?from=${from}&to=${to}${only}`),
  });
  const conns = useQuery({
    queryKey: ['sales-connections'],
    queryFn: () => apiGet<{ connections: Connection[]; serverReady: boolean }>('/sales/connections'),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sales'] });
    qc.invalidateQueries({ queryKey: ['sales-connections'] });
  };

  const connect = useMutation({
    mutationFn: (v: { businessId: number; secret: string }) =>
      apiPut(`/businesses/${v.businessId}/sales-connection`, { provider: 'yoco', secret: v.secret }),
    onSuccess: () => { setKey(''); setConnecting(false); refresh(); notify('Connected.', 'ok'); },
    onError: (e: Error) => notify(e.message, 'error'),
  });
  const sync = useMutation({
    mutationFn: (bid: number) => apiPost<{ message: string }>(`/businesses/${bid}/sales-connection/sync`),
    onSuccess: (r) => { refresh(); notify(r.message ?? 'Synced.', 'ok'); },
    onError: (e: Error) => notify(e.message, 'error'),
  });
  const addSale = useMutation({
    mutationFn: (v: { businessId: number; occurredAt: string; gross: number; fee: number; reference: string | null }) =>
      apiPost('/sales', v),
    onSuccess: () => {
      setDraft({ gross: '', fee: '', reference: '', occurredAt: iso(new Date()) });
      setAdding(false); refresh();
    },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const bid = businessId === 'all' ? null : Number(businessId);
  const conn = conns.data?.connections.find((c) => c.businessId === bid) ?? null;

  if (sales.error) return <ErrorNote error={sales.error} onRetry={() => sales.refetch()} />;

  return (
    <div className="space-y-5">
      {/* ---- what it added up to ------------------------------------------- */}
      {sales.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      ) : (sales.data?.totals.length ?? 0) === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-center">
          <CreditCard className="mx-auto mb-2 text-slate-600" size={22} />
          <p className="text-sm text-slate-300">No takings in this period.</p>
          <p className="mt-1 text-xs text-slate-500">
            Connect a card machine below, or add a counter sale by hand.
          </p>
        </div>
      ) : (
        sales.data!.totals.map((t) => (
          <div key={t.currency} className="grid gap-3 sm:grid-cols-3">
            <Figure label={`Taken (${t.currency})`} value={format(t.gross, t.currency)}
              hint={`${t.count} ${t.count === 1 ? 'sale' : 'sales'}`} />
            {/* Never hidden: the fee is the reason gross and net differ. */}
            <Figure label="Kept by the provider" value={format(t.fee, t.currency)} warn
              hint={t.gross > 0 ? `${((t.fee / t.gross) * 100).toFixed(2)}% of what you took` : undefined} />
            <Figure label="Reached the bank" value={format(t.net, t.currency)} accent
              hint={t.outputVat > 0 ? `Includes ${format(t.outputVat, t.currency)} output VAT` : undefined} />
          </div>
        ))
      )}

      {/* ---- range + add ---------------------------------------------------- */}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-[11px] text-slate-500">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fieldInlineClass} />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-slate-500">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={fieldInlineClass} />
        </div>
        <div className="flex-1" />
        {bid && (
          <button onClick={() => setAdding((v) => !v)} className={btnSecondary + ' flex items-center gap-1.5'}>
            <Plus size={15} /> Add a sale
          </button>
        )}
      </div>

      {adding && bid && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const gross = Number(draft.gross);
            if (!(gross > 0)) return;
            addSale.mutate({
              businessId: bid, occurredAt: draft.occurredAt, gross,
              fee: Number(draft.fee) || 0, reference: draft.reference.trim() || null,
            });
          }}
          className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-4">
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">Date</label>
            <input type="date" value={draft.occurredAt} required
              onChange={(e) => setDraft({ ...draft, occurredAt: e.target.value })} className={fieldClass} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">Amount taken</label>
            <input type="number" step="0.01" min="0" required value={draft.gross} placeholder="1150.00"
              onChange={(e) => setDraft({ ...draft, gross: e.target.value })} className={fieldClass} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">Fee, if any</label>
            <input type="number" step="0.01" min="0" value={draft.fee} placeholder="0.00"
              onChange={(e) => setDraft({ ...draft, fee: e.target.value })} className={fieldClass} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">Reference</label>
            <div className="flex gap-2">
              <input value={draft.reference} placeholder="Slip number"
                onChange={(e) => setDraft({ ...draft, reference: e.target.value })} className={fieldClass} />
              <button type="submit" disabled={addSale.isPending} className={btnPrimary}>Add</button>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 sm:col-span-4">
            VAT is worked out of the amount taken, not added to it, because money received already includes it.
          </p>
        </form>
      )}

      {/* ---- the sales themselves ------------------------------------------- */}
      {(sales.data?.sales.length ?? 0) > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Where</th>
                <th className="px-3 py-2 text-right font-medium">Taken</th>
                <th className="px-3 py-2 text-right font-medium">Fee</th>
                <th className="px-3 py-2 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {sales.data!.sales.map((s) => (
                <tr key={s.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-2 text-slate-300">
                    <span className="num">{s.occurredAt.slice(0, 10)}</span>
                    {s.reference && <span className="ml-2 text-[11px] text-slate-500">{s.reference}</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {s.source === 'card_machine' ? 'Card machine' : s.source || 'Counter'}
                    {s.terminal && <span className="ml-1 text-[11px] text-slate-600">{s.terminal}</span>}
                  </td>
                  <td className="px-3 py-2 text-right num text-slate-100">{format(Number(s.gross), s.currency)}</td>
                  <td className="px-3 py-2 text-right num text-amber-300/80">{format(Number(s.fee), s.currency)}</td>
                  <td className="px-3 py-2 text-right num text-slate-300">{format(Number(s.net), s.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- the card machine ------------------------------------------------ */}
      {bid && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          <div className="mb-1 flex items-center gap-2">
            <Link2 size={15} className="text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-200">Card machine</h3>
          </div>
          {conn?.hasKey ? (
            <>
              <p className="text-xs text-slate-500">
                Yoco is connected. Takings and their fees are pulled every morning.
                {conn.lastSyncedAt && (
                  <> Last checked <span className="num">{conn.lastSyncedAt.slice(0, 10)}</span>.</>
                )}
              </p>
              {conn.lastStatus && <p className="mt-1 text-[11px] text-slate-500">{conn.lastStatus}</p>}
              <button onClick={() => sync.mutate(bid)} disabled={sync.isPending}
                className={btnSecondary + ' mt-3 flex items-center gap-1.5'}>
                <RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />
                {sync.isPending ? 'Checking...' : 'Check now'}
              </button>
            </>
          ) : connecting ? (
            <form
              onSubmit={(e) => { e.preventDefault(); if (key.trim()) connect.mutate({ businessId: bid, secret: key.trim() }); }}
              className="mt-2 space-y-2">
              <p className="text-xs text-slate-500">
                Paste a Yoco API key. It is tried before it is saved, so a key that does not
                work never sits here looking connected.
              </p>
              <div className="flex flex-wrap gap-2">
                <input value={key} onChange={(e) => setKey(e.target.value)} type="password"
                  placeholder="Yoco API key" className={fieldClass + ' max-w-sm'} autoFocus />
                <button type="submit" disabled={!key.trim() || connect.isPending} className={btnPrimary}>
                  {connect.isPending ? 'Checking...' : 'Connect'}
                </button>
                <button type="button" onClick={() => { setConnecting(false); setKey(''); }} className={btnSecondary}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                Connect Yoco and every tap on the machine shows up here, with the fee it cost
                you, without anyone typing it in.
              </p>
              <button onClick={() => setConnecting(true)} className={btnSecondary + ' mt-3'}>
                Connect Yoco
              </button>
            </>
          )}
        </div>
      )}

      {businessId === 'all' && (
        <p className="text-[11px] text-slate-500">
          Pick one business above to connect a card machine or add a sale by hand.
        </p>
      )}
    </div>
  );
}

function Figure({ label, value, hint, warn, accent }: {
  label: string; value: string; hint?: string; warn?: boolean; accent?: boolean;
}) {
  return (
    <div className={`rounded-2xl border p-4 ${
      warn ? 'border-amber-500/25 bg-amber-500/[0.05]'
        : accent ? 'border-[var(--accent)]/30 bg-[var(--accent-quiet)]'
          : 'border-slate-800 bg-slate-900/40'}`}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`num mt-1 text-xl font-semibold ${
        warn ? 'text-amber-300' : accent ? 'text-[var(--accent)]' : 'text-slate-100'}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}
