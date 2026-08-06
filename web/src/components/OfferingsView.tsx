import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, PackageSearch, Repeat, Pause, Play, XCircle } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import type { Business, BusinessType, Offering, Subscription, Folder } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';

const ALL_TYPES: { value: BusinessType; label: string }[] = [
  { value: 'services', label: 'Services' }, { value: 'products', label: 'Products' },
  { value: 'code', label: 'Code' }, { value: 'content', label: 'Content' },
];

/** How a billing cadence reads: short form on a row, long form in a sentence. */
const INTERVAL_SHORT: Record<number, string> = { 1: 'mo', 3: 'quarter', 6: '6mo', 12: 'yr' };
const INTERVAL_WORD: Record<number, string> = { 1: 'month', 3: 'quarter', 6: 'six months', 12: 'year' };

function money(v: string | number) {
  const n = typeof v === 'string' ? Number(v) : v;
  return `R ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function OfferingsView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Offering | 'new' | null>(null);
  const [startingSub, setStartingSub] = useState(false);
  const bizParam = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const newBusinessId = businessId === 'all' ? undefined : businessId;

  // Which types this business's offerings should show fields for. `type` is the
  // permanent one chosen at creation (it drove the seed content); secondaryTypes are
  // extra modules turned on later - a business is rarely just one thing.
  const bizList = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const business = businessId === 'all' ? undefined : bizList.data?.businesses.find((b) => b.id === businessId);
  const activeTypes: BusinessType[] = business ? [business.type, ...business.secondaryTypes] : [];
  const setTypes = useMutation({
    mutationFn: (secondaryTypes: BusinessType[]) => apiPatch(`/businesses/${businessId}`, { secondaryTypes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['businesses'] }),
  });
  const toggleType = (t: BusinessType) => {
    if (!business || t === business.type) return; // primary type can't be turned off
    const next = business.secondaryTypes.includes(t)
      ? business.secondaryTypes.filter((x) => x !== t)
      : [...business.secondaryTypes, t];
    setTypes.mutate(next);
  };

  const { data } = useQuery({
    queryKey: ['offerings', businessId],
    queryFn: () => apiGet<{ offerings: Offering[]; mrr: number }>(`/offerings${bizParam}`),
  });
  const rows = data?.offerings ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['offerings'] });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/offerings/${id}`), onSuccess: invalidate });
  const toggleActive = useMutation({
    mutationFn: (v: { id: number; active: boolean }) => apiPatch(`/offerings/${v.id}`, { active: v.active }),
    onSuccess: invalidate,
  });

  const subsQ = useQuery({
    queryKey: ['subscriptions', businessId],
    queryFn: () => apiGet<{ subscriptions: Subscription[] }>(`/subscriptions${bizParam}`),
  });
  const subs = subsQ.data?.subscriptions ?? [];
  const invalidateSubs = () => qc.invalidateQueries({ queryKey: ['subscriptions'] });
  const setSubStatus = useMutation({
    mutationFn: (v: { id: number; status: Subscription['status'] }) => apiPatch(`/subscriptions/${v.id}`, { status: v.status }),
    onSuccess: invalidateSubs,
  });
  const delSub = useMutation({ mutationFn: (id: number) => apiDelete(`/subscriptions/${id}`), onSuccess: invalidateSubs });
  const recurringOfferings = rows.filter((o) => o.recurring && o.active);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-1 flex items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-100">Offerings</h1>
          <button onClick={() => setEditing('new')}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500">
            <Plus size={15} /> New offering
          </button>
        </div>
        <p className="mb-3 text-xs text-slate-500">What this business actually sells. Rename, price and stock these however fits.</p>

        {business && (
          <div className="mb-5 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] uppercase tracking-wide text-slate-500">This business is:</span>
            {ALL_TYPES.map((t) => {
              const isPrimary = business.type === t.value;
              const on = isPrimary || business.secondaryTypes.includes(t.value);
              return (
                <button key={t.value} type="button" onClick={() => toggleType(t.value)} disabled={isPrimary}
                  title={isPrimary ? 'Primary type, set when this business was created' : undefined}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${
                    on ? 'border-violet-500 bg-violet-500/15 text-violet-200' : 'border-slate-700 text-slate-500 hover:border-slate-600'
                  } ${isPrimary ? 'cursor-default' : ''}`}>
                  {t.label}
                </button>
              );
            })}
          </div>
        )}

        {data && rows.length > 0 && rows.some((o) => o.recurring) && (
          <div className="mb-4 rounded-lg border border-violet-800/50 bg-violet-500/10 px-4 py-2.5 text-sm text-violet-200">
            Monthly recurring revenue (MRR): <span className="font-semibold">{money(data.mrr)}</span>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Cost</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Stock</th>
                <th className="px-3 py-2 font-medium"></th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">
                  <PackageSearch size={22} className="mx-auto mb-2 opacity-50" />
                  Nothing here yet. Add what you sell.
                </td></tr>
              )}
              {rows.map((o) => (
                <tr key={o.id} className={`group border-t border-slate-800 ${o.active ? '' : 'opacity-50'}`}>
                  <td className="px-3 py-2 font-medium text-slate-200">{o.name}</td>
                  <td className="px-3 py-2 text-right num text-slate-100">
                    {money(o.price)}{o.unit ? <span className="text-slate-500"> /{o.unit}</span> : null}
                  </td>
                  <td className="hidden px-3 py-2 text-right num text-slate-400 sm:table-cell">{o.cost ? money(o.cost) : '-'}</td>
                  <td className="hidden px-3 py-2 text-right num text-slate-400 sm:table-cell">
                    {o.stockQty == null ? '-' : (
                      <span className={o.reorderPoint != null && o.stockQty <= o.reorderPoint ? 'text-amber-400' : ''}>{o.stockQty}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {o.recurring && <span className="rounded-md bg-violet-600/30 px-2 py-0.5 text-[11px] text-violet-200">recurring</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => toggleActive.mutate({ id: o.id, active: !o.active })}
                        title={o.active ? 'Archive' : 'Reactivate'}
                        className="text-[11px] text-slate-500 hover:text-slate-200">{o.active ? 'Archive' : 'Reactivate'}</button>
                      <button onClick={() => setEditing(o)} title="Edit" className="text-slate-500 hover:text-slate-200"><Pencil size={14} /></button>
                      <button onClick={() => { if (confirm(`Delete "${o.name}"?`)) del.mutate(o.id); }} title="Delete" className="text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {recurringOfferings.length > 0 && (
          <>
            <div className="mb-1 mt-8 flex items-center gap-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-200"><Repeat size={14} /> Subscriptions</h2>
              <button onClick={() => setStartingSub(true)}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800">
                <Plus size={13} /> Start subscription
              </button>
            </div>
            <p className="mb-4 text-xs text-slate-500">Bills a client automatically every month for a recurring offering. Invoices land as drafts for you to review before sending.</p>

            <div className="overflow-hidden rounded-xl border border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 font-medium">Offering</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Next bill</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {subs.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">No subscriptions yet.</td></tr>
                  )}
                  {subs.map((s) => (
                    <tr key={s.id} className={`border-t border-slate-800 ${s.status === 'canceled' ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2 text-slate-200">{s.clientName}</td>
                      <td className="px-3 py-2 text-slate-300">{s.offeringName} <span className="text-slate-500">({money(s.price)}/{INTERVAL_SHORT[s.intervalMonths ?? 1] ?? `${s.intervalMonths}mo`})</span></td>
                      <td className="px-3 py-2">
                        <span className={`rounded-md px-2 py-0.5 text-[11px] ${
                          s.status === 'active' ? 'bg-green-600/30 text-green-200'
                            : s.status === 'paused' ? 'bg-amber-600/30 text-amber-200' : 'bg-slate-800 text-slate-500'}`}>
                          {s.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 num text-slate-400">{s.status === 'active' ? s.nextBillDate : '-'}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-2">
                          {s.status === 'active' && (
                            <button onClick={() => setSubStatus.mutate({ id: s.id, status: 'paused' })} title="Pause" className="text-slate-500 hover:text-amber-300"><Pause size={14} /></button>
                          )}
                          {s.status === 'paused' && (
                            <button onClick={() => setSubStatus.mutate({ id: s.id, status: 'active' })} title="Resume" className="text-slate-500 hover:text-green-300"><Play size={14} /></button>
                          )}
                          {s.status !== 'canceled' && (
                            <button onClick={() => { if (confirm('Cancel this subscription? It will stop billing.')) setSubStatus.mutate({ id: s.id, status: 'canceled' }); }} title="Cancel" className="text-slate-500 hover:text-red-400"><XCircle size={14} /></button>
                          )}
                          <button onClick={() => { if (confirm('Delete this subscription record entirely?')) delSub.mutate(s.id); }} title="Delete" className="text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {editing && (
        <OfferingEditor
          offering={editing === 'new' ? null : editing}
          activeTypes={activeTypes}
          businessId={newBusinessId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate(); }}
        />
      )}
      {startingSub && (
        <StartSubscriptionModal
          businessId={newBusinessId}
          recurringOfferings={recurringOfferings}
          onClose={() => setStartingSub(false)}
          onStarted={() => { setStartingSub(false); invalidateSubs(); }}
        />
      )}
    </div>
  );
}

function StartSubscriptionModal({ businessId, recurringOfferings, onClose, onStarted }: {
  businessId?: number;
  recurringOfferings: Offering[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const [offeringId, setOfferingId] = useState<string>(recurringOfferings[0] ? String(recurringOfferings[0].id) : '');
  const [folderId, setFolderId] = useState('');
  const [intervalMonths, setIntervalMonths] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const foldersQ = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const clientFolders = (foldersQ.data?.folders ?? []).filter((f) =>
    f.parentId === null && f.pillar === 'delivery' && (businessId === undefined || f.businessId === businessId));

  const start = useMutation({
    mutationFn: () => apiPost('/subscriptions', {
      offeringId: Number(offeringId), folderId: Number(folderId), businessId, intervalMonths,
    }),
    onSuccess: onStarted,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not start subscription.'),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (offeringId && folderId) start.mutate(); }}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Start subscription</h2>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <label className="mb-1 block text-xs text-slate-400">Offering</label>
        <select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}
          className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500">
          {recurringOfferings.map((o) => <option key={o.id} value={o.id}>{o.name} ({money(o.price)}/mo)</option>)}
        </select>

        <label className="mb-1 block text-xs text-slate-400">Client</label>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500">
          <option value="">Choose a client...</option>
          {clientFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>

        <label className="mb-1 block text-xs text-slate-400">Bills every</label>
        <select value={intervalMonths} onChange={(e) => setIntervalMonths(Number(e.target.value))}
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500">
          <option value={1}>Month</option>
          <option value={3}>Quarter (3 months)</option>
          <option value={6}>6 months</option>
          <option value={12}>Year</option>
        </select>

        <p className="mb-4 text-[11px] text-slate-500">
          Bills the first {INTERVAL_WORD[intervalMonths] ?? 'cycle'} immediately as a draft invoice, then repeats automatically. A month-end
          date stays at month end rather than drifting earlier.
        </p>

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={!offeringId || !folderId || start.isPending}
          className="w-full rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {start.isPending ? 'Starting...' : 'Start subscription'}
        </button>
      </form>
    </div>
  );
}

function OfferingEditor({ offering, activeTypes, businessId, onClose, onSaved }: {
  offering: Offering | null;
  activeTypes: BusinessType[];
  businessId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !offering;
  const [name, setName] = useState(offering?.name ?? '');
  const [price, setPrice] = useState(offering?.price ?? '0');
  const [unit, setUnit] = useState(offering?.unit ?? '');
  const [cost, setCost] = useState(offering?.cost ?? '');
  const [stockQty, setStockQty] = useState(offering?.stockQty != null ? String(offering.stockQty) : '');
  const [reorderPoint, setReorderPoint] = useState(offering?.reorderPoint != null ? String(offering.reorderPoint) : '');
  const [recurring, setRecurring] = useState(offering?.recurring ?? false);
  const [error, setError] = useState<string | null>(null);

  const showStock = activeTypes.includes('products') || stockQty !== '';
  const showRecurring = activeTypes.includes('code') || recurring;
  const showCost = activeTypes.includes('products') || cost !== '';

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(), price: Number(price) || 0, unit: unit.trim() || null,
        cost: cost.trim() ? Number(cost) : null, recurring,
        stockQty: stockQty.trim() ? Number(stockQty) : null,
        reorderPoint: reorderPoint.trim() ? Number(reorderPoint) : null,
        ...(isNew ? { businessId } : {}),
      };
      return isNew ? apiPost('/offerings', body) : apiPatch(`/offerings/${offering!.id}`, body);
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(); }}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{isNew ? 'New offering' : 'Edit offering'}</h2>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <label className="mb-1 block text-xs text-slate-400">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Website Audit"
          className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Price</label>
            <input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Per (optional)</label>
            <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="hour, unit, month..."
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
          </div>
        </div>

        {showCost && (
          <div className="mb-3">
            <label className="mb-1 block text-xs text-slate-400">Cost (what it costs you)</label>
            <input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
          </div>
        )}

        {showStock && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs text-slate-400">In stock</label>
              <input type="number" value={stockQty} onChange={(e) => setStockQty(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Reorder at</label>
              <input type="number" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
            </div>
          </div>
        )}

        {showRecurring && (
          <label className="mb-4 flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-slate-900 accent-violet-600" />
            Recurring revenue (counts toward MRR)
          </label>
        )}
        {!showRecurring && (
          <button type="button" onClick={() => setRecurring(true)} className="mb-4 text-[11px] text-slate-500 hover:text-slate-300">
            + mark as recurring revenue
          </button>
        )}

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={!name.trim() || save.isPending}
          className="w-full rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {save.isPending ? 'Saving...' : isNew ? 'Add offering' : 'Save changes'}
        </button>
      </form>
    </div>
  );
}
