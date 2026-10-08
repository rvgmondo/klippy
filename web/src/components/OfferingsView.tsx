import { useState } from 'react';
import { useFromBusiness, PICK_BUSINESS } from './FromBusiness';
import { confirmDialog, notify } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, PackageSearch, Repeat, Copy, Search } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { Skeleton } from './ui';
import type { Business, BusinessType, Offering, Subscription, Folder } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';
import { Modal } from './Modal';
import { money as fmt } from '../lib/money';
import { useCurrency } from '../lib/useCurrency';
import { navigateTo, useUrlAction } from '../lib/urlAction';
import { Page, PageHeader, PageBody } from './PageHeader';

const ALL_TYPES: { value: BusinessType; label: string }[] = [
  { value: 'services', label: 'Services' }, { value: 'products', label: 'Products' },
  { value: 'code', label: 'Code' }, { value: 'content', label: 'Content' },
];



export function OfferingsView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  // What this business bills in. Both of these screens used to print a rand sign
  // regardless of the setting, so a dollar business saw its own prices mislabelled.
  const cur = useCurrency(businessId);
  const money = (v: string | number) => fmt(v, cur);
  const [editing, setEditing] = useState<Offering | 'new' | null>(null);
  const [startingSub, setStartingSub] = useState(false);
  const [subFolder, setSubFolder] = useState<number | null>(null);
  useUrlAction('new', () => setEditing('new'));
  useUrlAction('sub', (v) => {
    const n = Number(v);
    setSubFolder(Number.isFinite(n) && n > 1 ? n : null);
    setStartingSub(true);
  });
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

  const { data, isLoading } = useQuery({
    queryKey: ['offerings', businessId],
    queryFn: () => apiGet<{
      offerings: Offering[];
      /** Real MRR, from active subscriptions, one figure per currency. */
      mrr: { currency: string; mrr: number; subscriptions: number }[];
    }>(`/offerings${bizParam}`),
  });
  const allRows = data?.offerings ?? [];
  // Archived items used to sit in the list at half strength forever. They are kept
  // (old invoices and subscriptions point at them) but tucked away by default.
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'list' | 'earned'>('list');
  const archivedCount = allRows.filter((o) => !o.active).length;
  const q = query.trim().toLowerCase();
  const rows = allRows
    .filter((o) => showArchived || o.active)
    .filter((o) => !q || o.name.toLowerCase().includes(q) || (o.description ?? '').toLowerCase().includes(q))
    .sort((a, b) => sort === 'earned' ? (b.usage?.revenue12m ?? 0) - (a.usage?.revenue12m ?? 0) : 0);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['offerings'] });
  const del = useMutation({
    mutationFn: (id: number) => apiDelete(`/offerings/${id}`),
    onSuccess: invalidate,
    // The server refuses when clients are subscribed to it, and says why. That
    // reason used to be swallowed, so the button simply did nothing.
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not delete that.', 'error'),
  });
  const duplicate = useMutation({
    mutationFn: (o: Offering) => apiPost('/offerings', {
      businessId: o.businessId, name: `${o.name} (copy)`.slice(0, 150), description: o.description,
      price: Number(o.price) || 0, cost: o.cost != null ? Number(o.cost) : null, unit: o.unit,
      recurring: o.recurring, stockQty: null, reorderPoint: o.reorderPoint,
      provisioning: o.provisioning ?? 'none', whmPackage: o.whmPackage ?? null,
    }),
    onSuccess: () => { invalidate(); notify('Copied. Rename and price the copy.', 'ok'); },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not copy that.', 'error'),
  });
  const toggleActive = useMutation({
    mutationFn: (v: { id: number; active: boolean }) => apiPatch(`/offerings/${v.id}`, { active: v.active }),
    onSuccess: invalidate,
  });

  const subsQ = useQuery({
    queryKey: ['subscriptions', businessId],
    queryFn: () => apiGet<{ subscriptions: Subscription[] }>(`/subscriptions${bizParam}`),
  });
  const activeSubs = (subsQ.data?.subscriptions ?? []).filter((x) => x.status === 'active').length;
  const invalidateSubs = () => {
    qc.invalidateQueries({ queryKey: ['subscriptions'] });
    qc.invalidateQueries({ queryKey: ['offerings'] });
    qc.invalidateQueries({ queryKey: ['report'] });
  };
  const recurringOfferings = rows.filter((o) => o.recurring && o.active);

  return (
    <Page>
      <PageHeader view="offerings" title="Price list"
        subtitle="What this business actually sells. Rename, price and stock these however fits."
        actions={(
          <button onClick={() => setEditing('new')}
            className="flex min-h-10 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 sm:min-h-9">
            <Plus size={15} /> New offering
          </button>
        )} />
      <PageBody>

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
            Monthly recurring revenue (MRR):{' '}
            {(data.mrr ?? []).length === 0
              ? <span className="font-semibold">{money(0)}</span>
              : (data.mrr).map((m, i) => (
                  <span key={m.currency}>
                    {i > 0 ? '  |  ' : ''}
                    <span className="font-semibold">{fmt(m.mrr, m.currency)}</span>
                    <span className="text-slate-500"> from {m.subscriptions} subscription{m.subscriptions === 1 ? '' : 's'}</span>
                  </span>
                ))}
          </div>
        )}

        {allRows.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an item" aria-label="Find an item"
                className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-900/70 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500 sm:min-h-9" />
            </label>
            <select value={sort} onChange={(e) => setSort(e.target.value as 'list' | 'earned')} aria-label="Order"
              className="min-h-10 rounded-lg border border-slate-700 bg-slate-900/70 px-2 text-sm text-slate-200 sm:min-h-9">
              <option value="list">Your order</option>
              <option value="earned">Earned most</option>
            </select>
            {archivedCount > 0 && (
              <button onClick={() => setShowArchived((v) => !v)}
                className="min-h-10 rounded-lg px-2 text-xs text-slate-400 hover:text-slate-200 sm:min-h-9">
                {showArchived ? 'Hide archived' : `Show ${archivedCount} archived`}
              </button>
            )}
          </div>
        )}

        {isLoading && <Skeleton className="h-48" />}
        {!isLoading && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell" title="Price less cost, where a cost is set">Margin</th>
                <th className="hidden px-3 py-2 text-right font-medium md:table-cell" title="On invoices sent or paid in the last 12 months">Last 12 months</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Stock</th>
                <th className="px-3 py-2 font-medium"></th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-500">
                  <PackageSearch size={22} className="mx-auto mb-2 opacity-50" />
                  {allRows.length === 0 ? 'Nothing here yet. Add what you sell.' : 'Nothing matches.'}
                </td></tr>
              )}
              {rows.map((o) => (
                <tr key={o.id} className={`group border-t border-slate-800 ${o.active ? '' : 'opacity-50'}`}>
                  <td className="max-w-[18rem] px-3 py-2">
                    <span className="block font-medium text-slate-200">{o.name}</span>
                    {o.description && <span className="block truncate text-xs text-slate-500">{o.description}</span>}
                  </td>
                  <td className="px-3 py-2 text-right num text-slate-100">
                    {money(o.price)}{o.unit ? <span className="text-slate-500"> /{o.unit}</span> : null}
                  </td>
                  <td className="hidden px-3 py-2 text-right num text-slate-400 sm:table-cell">
                    {o.cost != null && Number(o.price) > 0 ? (() => {
                      const m = Number(o.price) - Number(o.cost);
                      const pct = Math.round((m / Number(o.price)) * 100);
                      return <span className={m < 0 ? 'text-red-300' : pct < 20 ? 'text-amber-300' : ''} title={`Cost ${money(o.cost)}`}>{money(m)} <span className="text-slate-500">{pct}%</span></span>;
                    })() : '-'}
                  </td>
                  <td className="hidden px-3 py-2 text-right num md:table-cell">
                    {o.usage && o.usage.revenue12m > 0
                      ? <span className="text-slate-200" title={`${o.usage.sold12m} sold`}>{money(o.usage.revenue12m)}</span>
                      : <span className="text-slate-600">nothing</span>}
                  </td>
                  <td className="hidden px-3 py-2 text-right num text-slate-400 sm:table-cell">
                    {o.stockQty == null ? '-' : (
                      <span className={o.reorderPoint != null && o.stockQty <= o.reorderPoint ? 'text-amber-400' : ''}>{o.stockQty}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {o.recurring && (
                      <span className="whitespace-nowrap rounded-md bg-violet-600/30 px-2 py-0.5 text-[11px] text-violet-200"
                        title={o.usage?.subscribers ? `${o.usage.subscribers} active subscription${o.usage.subscribers === 1 ? '' : 's'}` : 'Nobody is subscribed yet'}>
                        recurring{o.usage?.subscribers ? `, ${o.usage.subscribers} on it` : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => toggleActive.mutate({ id: o.id, active: !o.active })}
                        title={o.active ? 'Archive' : 'Reactivate'}
                        className="tap px-2 text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-200">{o.active ? 'Archive' : 'Reactivate'}</button>
                      <button onClick={() => setEditing(o)} title="Edit" className="tap text-slate-500 hover:bg-slate-800 hover:text-slate-200"><Pencil size={14} /></button>
                      <button onClick={() => duplicate.mutate(o)} disabled={duplicate.isPending} title="Make a copy" className="tap text-slate-500 hover:bg-slate-800 hover:text-slate-200"><Copy size={14} /></button>
                      <button onClick={async () => { if (await confirmDialog(o.usage?.everUsed ? `"${o.name}" has subscriptions on it, so it can only be archived. Try deleting anyway?` : `Delete "${o.name}"?`, { danger: true })) del.mutate(o.id); }} title="Delete" className="tap text-slate-500 hover:bg-slate-800 hover:text-red-400"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}

        {recurringOfferings.length > 0 && (
          // Subscriptions have their own screen under Money now. The price list keeps
          // the way in, because this is where a repeating plan is set up.
          <div className="mt-8 flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
            <Repeat size={16} className="text-slate-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200">
                {activeSubs} active {activeSubs === 1 ? 'subscription' : 'subscriptions'}
              </p>
              <p className="text-xs text-slate-500">Who pays you on repeat, their next bill dates and every setting are under Money, Subscriptions.</p>
            </div>
            <button onClick={() => navigateTo('subscriptions')}
              className="min-h-10 rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800 sm:min-h-9">Open Subscriptions</button>
            <button onClick={() => setStartingSub(true)}
              className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800 sm:min-h-9">
              <Plus size={14} /> Start one
            </button>
          </div>
        )}
      </PageBody>

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
          initialFolderId={subFolder}
          onClose={() => { setStartingSub(false); setSubFolder(null); }}
          onStarted={() => { setStartingSub(false); setSubFolder(null); invalidateSubs(); }}
        />
      )}
    </Page>
  );
}

export function StartSubscriptionModal({ businessId, recurringOfferings, initialFolderId, onClose, onStarted }: {
  businessId?: number;
  recurringOfferings: Offering[];
  initialFolderId?: number | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const cur = useCurrency(businessId ?? 'all');
  const [folderId, setFolderId] = useState(initialFolderId ? String(initialFolderId) : '');
  const [error, setError] = useState<string | null>(null);

  /**
   * One start, several plans. A hosting client almost always signs up for more
   * than one thing at once (hosting monthly, the domain yearly), and starting
   * them one modal at a time was two trips through the same form. Each line is
   * its own subscription with its own cycle; they simply begin together.
   */
  interface Line { key: number; offeringId: string; price: string; intervalMonths: number; domain: string }
  const firstId = recurringOfferings[0] ? String(recurringOfferings[0].id) : '';
  const [lines, setLines] = useState<Line[]>([{ key: 1, offeringId: firstId, price: '', intervalMonths: 1, domain: '' }]);
  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const foldersQ = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const clientFolders = (foldersQ.data?.folders ?? []).filter((f) =>
    f.parentId === null && f.pillar === 'delivery' && (businessId === undefined || f.businessId === businessId));

  const offeringOf = (l: Line) => recurringOfferings.find((o) => String(o.id) === l.offeringId);

  const start = useMutation({
    mutationFn: async () => {
      // Sequential on purpose: invoice numbering and the first-cycle invoices
      // come out in a sane order, and a failure names the plan that caused it.
      const failed: string[] = [];
      let started = 0;
      for (const l of lines) {
        const o = offeringOf(l);
        if (!o) continue;
        try {
          await apiPost('/subscriptions', {
            offeringId: Number(l.offeringId), folderId: Number(folderId), businessId,
            intervalMonths: l.intervalMonths,
            ...(l.price.trim() ? { price: Number(l.price) } : {}),
            ...(l.domain.trim() ? { domain: l.domain.trim() } : {}),
          });
          started++;
        } catch (e) {
          failed.push(`${o.name}: ${e instanceof Error ? e.message : 'failed'}`);
        }
      }
      return { started, failed };
    },
    onSuccess: (r) => {
      if (r.failed.length) {
        setError(`Started ${r.started} of ${lines.length}. ${r.failed.join(' | ')}`);
        if (r.started) notify(`${r.started} subscription${r.started === 1 ? '' : 's'} started; fix the rest and try again.`);
      } else {
        notify(`${r.started} subscription${r.started === 1 ? '' : 's'} started.`);
        onStarted();
      }
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not start subscriptions.'),
  });

  const dirty = folderId !== (initialFolderId ? String(initialFolderId) : '')
    || lines.some((l) => l.price.trim() || l.domain.trim()) || lines.length > 1;

  return (
    <Modal onClose={onClose} variant="panel"
      confirmClose={() => (dirty
        ? confirmDialog('Close without starting these subscriptions?', { confirmLabel: 'Discard', danger: true }) : true)}>
      <form onSubmit={(e) => { e.preventDefault(); if (folderId && lines.every((l) => l.offeringId)) start.mutate(); }}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Start subscriptions</h2>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <label className="mb-1 block text-xs text-slate-400">Client</label>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500">
          <option value="">Choose a client...</option>
          {clientFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>

        {lines.map((l, idx) => {
          const o = offeringOf(l);
          return (
            <div key={l.key} className="mb-3 rounded-xl border border-slate-800 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Plan {idx + 1}</span>
                {lines.length > 1 && (
                  <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    className="tap text-slate-500 hover:bg-slate-800 hover:text-red-400" title="Remove this plan">
                    <X size={13} />
                  </button>
                )}
              </div>

              <label className="mb-1 block text-xs text-slate-400">Offering</label>
              <select value={l.offeringId} onChange={(e) => setLine(l.key, { offeringId: e.target.value })}
                className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500">
                {recurringOfferings.map((of2) => <option key={of2.id} value={of2.id}>{of2.name} ({fmt(of2.price, cur)})</option>)}
              </select>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-400">Bills every</span>
                  <select value={l.intervalMonths} onChange={(e) => setLine(l.key, { intervalMonths: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500">
                    <option value={1}>Month</option>
                    <option value={3}>Quarter</option>
                    <option value={6}>6 months</option>
                    <option value={12}>Year</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-400">Price for this client</span>
                  <input value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} type="number" step="0.01" min="0"
                    placeholder={o ? fmt(o.price, cur) : 'List price'}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500" />
                </label>
              </div>

              {/* A cPanel account cannot be created without a domain, so it is asked
                  for here rather than guessed at provisioning time. */}
              {o?.provisioning === 'cpanel' && (
                <label className="mt-2 block">
                  <span className="mb-1 block text-xs text-slate-400">Domain to host</span>
                  <input value={l.domain} onChange={(e) => setLine(l.key, { domain: e.target.value })} placeholder="clientsite.co.za"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
                  <span className="mt-1 block text-[11px] text-slate-500">
                    The hosting account is created when the first invoice is paid. Leave blank to start on a holding address.
                  </span>
                </label>
              )}
            </div>
          );
        })}

        <button type="button"
          onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, offeringId: firstId, price: '', intervalMonths: 1, domain: '' }])}
          className="mb-4 w-full rounded-lg border border-dashed border-slate-700 py-2 text-sm text-slate-400 hover:border-slate-500 hover:text-slate-200">
          + Add another plan
        </button>

        <p className="mb-4 text-[11px] text-slate-500">
          Each plan bills the first cycle immediately as a draft invoice, then repeats on its own
          rhythm: hosting can go monthly while the domain renews yearly. A month-end date stays
          at month end rather than drifting earlier.
        </p>

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={!folderId || lines.length === 0 || start.isPending}
          className="w-full rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {start.isPending ? 'Starting...' : lines.length > 1 ? `Start ${lines.length} subscriptions` : 'Start subscription'}
        </button>
      </form>
    </Modal>
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
  const from = useFromBusiness(businessId);
  const [name, setName] = useState(offering?.name ?? '');
  const [description, setDescription] = useState(offering?.description ?? '');
  const [price, setPrice] = useState(offering?.price ?? '0');
  const [unit, setUnit] = useState(offering?.unit ?? '');
  const [cost, setCost] = useState(offering?.cost ?? '');
  const [stockQty, setStockQty] = useState(offering?.stockQty != null ? String(offering.stockQty) : '');
  const [reorderPoint, setReorderPoint] = useState(offering?.reorderPoint != null ? String(offering.reorderPoint) : '');
  const [recurring, setRecurring] = useState(offering?.recurring ?? false);
  const [error, setError] = useState<string | null>(null);

  const showStock = activeTypes.includes('products') || stockQty !== '';
  const showRecurring = activeTypes.includes('code') || recurring;
  const [provisioning, setProvisioning] = useState(offering?.provisioning ?? 'none');
  const [whmPackage, setWhmPackage] = useState(offering?.whmPackage ?? '');
  const showCost = activeTypes.includes('products') || cost !== '';
  // Subscriptions with no price of their own pay the list price, so changing it
  // here changes their next bill. Said before saving, not discovered on the invoice.
  const followers = offering?.usage?.followPrice ?? 0;
  const priceChanged = !isNew && Number(price) !== Number(offering!.price);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(), description: description.trim() || null,
        price: Number(price) || 0, unit: unit.trim() || null,
        cost: cost.trim() ? Number(cost) : null, recurring,
        provisioning, whmPackage: whmPackage.trim() || null,
        stockQty: stockQty.trim() ? Number(stockQty) : null,
        reorderPoint: reorderPoint.trim() ? Number(reorderPoint) : null,
        ...(isNew && from.id ? { businessId: from.id } : {}),
      };
      if (isNew && from.missing) throw new Error(PICK_BUSINESS);
      return isNew ? apiPost('/offerings', body) : apiPatch(`/offerings/${offering!.id}`, body);
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  return (
    <Modal onClose={onClose} variant="panel"
      confirmClose={() => {
        const dirty = name !== (offering?.name ?? '') || description !== (offering?.description ?? '')
          || price !== (offering?.price ?? '0') || unit !== (offering?.unit ?? '');
        return dirty ? confirmDialog('Close without saving this offering?', { confirmLabel: 'Discard', danger: true }) : true;
      }}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(); }}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{isNew ? 'New price list item' : 'Edit price list item'}</h2>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>
        {isNew && from.element && <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900/40 p-3">{from.element}</div>}

        <label className="mb-1 block text-xs text-slate-400">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Website Audit"
          className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />

        <label className="mb-1 block text-xs text-slate-400">What it is</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Two lines on what the client actually gets. Printed under this item on quotes and invoices."
          className="mb-1 min-h-[64px] w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500" />
        <p className="mb-3 text-[11px] text-slate-500">
          Write it once here and every quote and invoice that sells this carries it, so a
          client is never left reading a bare product name and wondering what they paid for.
          Editable per line if one job needs different wording.
        </p>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Price</label>
            <input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Per (optional)</label>
            <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="hour, unit or month"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
          </div>
        </div>
        {priceChanged && followers > 0 && (
          <p className="-mt-1 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            {followers} subscription{followers === 1 ? ' pays' : 's pay'} the list price, so {followers === 1 ? 'its' : 'their'} next bill will be the new price.
            Clients on a price of their own are not affected.
          </p>
        )}

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

        {/* Only offered for recurring things, because hosting that does not renew is
            not hosting. The package name has to match one that exists on the server;
            Settings > Hosting lists them after a successful connection test. */}
        {recurring && (
          <div className="mb-4 rounded-lg border border-slate-800 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={provisioning === 'cpanel'}
                onChange={(e) => setProvisioning(e.target.checked ? 'cpanel' : 'none')}
                className="h-4 w-4 rounded border-slate-700 bg-slate-900 accent-violet-600" />
              Selling this sets up cPanel hosting
            </label>
            {provisioning === 'cpanel' && (
              <>
                <label className="mb-1 mt-3 block text-xs text-slate-400">WHM package</label>
                <input value={whmPackage} onChange={(e) => setWhmPackage(e.target.value)}
                  placeholder="e.g. starter"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
                <p className="mt-1 text-[11px] text-slate-500">
                  Must match a package on your WHM server. Settings &gt; Hosting lists them once the
                  connection test passes. The client's domain goes on the subscription, not here.
                </p>
              </>
            )}
          </div>
        )}

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={!name.trim() || save.isPending}
          className="w-full rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {save.isPending ? 'Saving...' : isNew ? 'Add offering' : 'Save changes'}
        </button>
      </form>
    </Modal>
  );
}
