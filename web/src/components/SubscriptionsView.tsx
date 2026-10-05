import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Repeat, Search, X, Pause, Play, XCircle, Trash2, Zap, CalendarClock } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { money } from '../lib/money';
import { navigateTo } from '../lib/urlAction';
import { confirmDialog, notify } from './ConfirmDialog';
import { Page, PageHeader, PageBody } from './PageHeader';
import { Skeleton, btnPrimary, btnSecondary, fieldClass } from './ui';
import { StartSubscriptionModal } from './OfferingsView';
import type { BusinessSelection } from './BusinessSwitcher';
import type { Business, Offering, Subscription } from '../lib/types';

/**
 * Everything that bills on repeat, in one place.
 *
 * It used to be a table at the bottom of the price list, which answered "what do
 * I sell" when the question was "who pays me every month, and when does each one
 * bill next". Sorted by the next bill date, because that is the order things
 * happen in. Opening one shows every setting it has, with the dates a change
 * will produce shown before it is saved.
 */

type Sub = Subscription & {
  billingDay: number | null; endsOn: string | null; notes: string | null;
  businessName: string; currency: string; billsOnDay: number;
};
type Filter = 'active' | 'paused' | 'ended' | 'all';

const EVERY: Record<number, { short: string; long: string }> = {
  1: { short: 'month', long: 'Every month' },
  2: { short: '2 months', long: 'Every 2 months' },
  3: { short: 'quarter', long: 'Every 3 months' },
  6: { short: '6 months', long: 'Every 6 months' },
  12: { short: 'year', long: 'Every year' },
};
const every = (n: number) => EVERY[n] ?? { short: `${n} months`, long: `Every ${n} months` };

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysUntil = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00`) - Date.parse(`${todayIso()}T00:00:00`)) / 86400000);
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const when = (iso: string) => {
  const n = daysUntil(iso);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? 'due now' : n < 45 ? `in ${n} days` : fmtShort(iso);
};
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** The same month arithmetic the server uses, so the preview matches what will happen. */
function addMonths(iso: string, months: number, day: number): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const target = new Date(Date.UTC(y, m - 1 + Math.max(1, months), 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
function nextDates(from: string, months: number, day: number, n: number, endsOn: string | null): string[] {
  const out: string[] = [];
  let d = from;
  for (let i = 0; i < n && !(endsOn && d > endsOn); i++) { out.push(d); d = addMonths(d, months, day); }
  return out;
}

const isEnded = (s: Sub) => s.status === 'canceled';

export function SubscriptionsView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const bizParam = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data, isLoading } = useQuery({
    queryKey: ['subscriptions', businessId],
    queryFn: () => apiGet<{ subscriptions: Sub[] }>(`/subscriptions${bizParam}`),
  });
  const businesses = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const offeringsQ = useQuery({
    queryKey: ['offerings', businessId],
    queryFn: () => apiGet<{ offerings: Offering[] }>(`/offerings${bizParam}`),
  });
  const [filter, setFilter] = useState<Filter>('active');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  const subs = data?.subscriptions ?? [];
  const multi = (businesses.data?.businesses.length ?? 0) > 1;
  const counts = {
    active: subs.filter((s) => s.status === 'active').length,
    paused: subs.filter((s) => s.status === 'paused').length,
    ended: subs.filter(isEnded).length,
    all: subs.length,
  };

  // Money per month from what is active, one figure per currency, never added across.
  const monthly = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of subs) if (s.status === 'active') m.set(s.currency, (m.get(s.currency) ?? 0) + Number(s.price) / (s.intervalMonths || 1));
    return [...m.entries()];
  }, [subs]);
  const soon = subs.filter((s) => s.status === 'active' && daysUntil(s.nextBillDate) <= 30);
  const soonByCur = new Map<string, number>();
  for (const s of soon) soonByCur.set(s.currency, (soonByCur.get(s.currency) ?? 0) + Number(s.price));

  const needle = q.trim().toLowerCase();
  const shown = subs
    .filter((s) => filter === 'all' || (filter === 'ended' ? isEnded(s) : s.status === filter))
    .filter((s) => !needle || `${s.clientName} ${s.offeringName} ${s.domain ?? ''} ${s.businessName}`.toLowerCase().includes(needle))
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)
      || a.nextBillDate.localeCompare(b.nextBillDate) || a.clientName.localeCompare(b.clientName));
  const open = subs.find((s) => s.id === openId) ?? null;
  const recurring = (offeringsQ.data?.offerings ?? []).filter((o) => o.recurring && o.active);

  return (
    <Page>
      <PageHeader view="subscriptions" title="Subscriptions"
        subtitle="Everyone who pays you on repeat, and when each one bills next."
        actions={recurring.length > 0 ? (
          <button onClick={() => setStarting(true)} className={`${btnPrimary} inline-flex min-h-10 items-center gap-1.5 sm:min-h-9`}>
            <Plus size={15} /> Start a subscription
          </button>
        ) : undefined} />
      <PageBody>
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <Stat label="Comes in every month" value={monthly.length ? monthly.map(([c, v]) => money(v, c)).join(' and ') : 'Nothing yet'}
            sub={`${counts.active} active`} />
          <Stat label="Bills in the next 30 days" value={soonByCur.size ? [...soonByCur].map(([c, v]) => money(v, c)).join(' and ') : 'Nothing'}
            sub={`${soon.length} ${soon.length === 1 ? 'invoice' : 'invoices'}`} />
          <Stat label="Paused" value={String(counts.paused)} sub={counts.paused ? 'Not billing until you resume them' : 'None'} />
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-slate-900/60 p-1">
            {(['active', 'paused', 'ended', 'all'] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                className={`rounded-md px-3 py-1.5 text-sm ${filter === f ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
                {f === 'active' ? 'Active' : f === 'paused' ? 'Paused' : f === 'ended' ? 'Cancelled' : 'All'}
                <span className="num ml-1.5 text-xs text-slate-500">{counts[f]}</span>
              </button>
            ))}
          </div>
          <label className="relative ml-auto w-full sm:w-64">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client or plan" aria-label="Find a client or plan"
              className={`${fieldClass} pl-8`} />
          </label>
        </div>

        {isLoading ? <Skeleton className="h-48" /> : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
            <Repeat size={22} className="mx-auto mb-2 opacity-50" />
            {subs.length === 0
              ? recurring.length ? 'No subscriptions yet. Start one for a client who pays you monthly.'
                : 'No subscriptions yet. First add something that repeats to your Price list, like monthly hosting.'
              : 'Nothing here.'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-800">
            {shown.map((s) => {
              const n = daysUntil(s.nextBillDate);
              return (
                <button key={s.id} onClick={() => setOpenId(s.id)}
                  className={`flex w-full items-center gap-3 border-b border-slate-800 bg-slate-900/30 px-3 py-3 text-left last:border-b-0 hover:bg-slate-800/40 ${isEnded(s) ? 'opacity-60' : ''}`}>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-100">{s.clientName}</span>
                      {s.status === 'paused' && <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">Paused</span>}
                      {isEnded(s) && <span className="shrink-0 rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] text-slate-400">Cancelled</span>}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {s.offeringName}{s.domain ? `, ${s.domain}` : ''}{multi ? `, ${s.businessName}` : ''}
                    </span>
                  </span>
                  <span className="hidden w-36 shrink-0 text-xs text-slate-400 sm:block">
                    {s.autoDebit && s.hasCard ? 'Card charged' : s.autoSend ? 'Emailed to them' : 'Draft for you to send'}
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs sm:w-28">
                    {s.status === 'active' ? (
                      <>
                        <span className={`block ${n <= 3 ? 'text-amber-300' : 'text-slate-300'}`}>{when(s.nextBillDate)}</span>
                        <span className="block text-slate-500">{fmtShort(s.nextBillDate)}</span>
                      </>
                    ) : <span className="text-slate-500">Not billing</span>}
                  </span>
                  <span className="num w-24 shrink-0 text-right text-sm text-slate-100 sm:w-28">
                    {money(s.price, s.currency)}
                    <span className="block text-[11px] text-slate-500">a {every(s.intervalMonths).short}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </PageBody>

      {open && <SubscriptionSheet sub={open} offerings={recurring.filter((o) => o.businessId === open.businessId)}
        onClose={() => setOpenId(null)} onChanged={() => {
          void qc.invalidateQueries({ queryKey: ['subscriptions'] });
          void qc.invalidateQueries({ queryKey: ['subscription', open.id] });
          void qc.invalidateQueries({ queryKey: ['offerings'] });
          void qc.invalidateQueries({ queryKey: ['report'] });
        }} />}
      {starting && (
        <StartSubscriptionModal
          businessId={businessId === 'all' ? undefined : businessId}
          recurringOfferings={recurring}
          onClose={() => setStarting(false)}
          onStarted={() => { setStarting(false); void qc.invalidateQueries({ queryKey: ['subscriptions'] }); }}
        />
      )}
    </Page>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="num mt-0.5 text-lg font-semibold text-slate-100">{value}</p>
      <p className="text-xs text-slate-500">{sub}</p>
    </div>
  );
}

/**
 * One subscription and every setting it has.
 *
 * One Save for the settings, so a change is made deliberately. The dates it will
 * bill on are worked out live from what is on the form, so moving the date or the
 * day shows its effect before anything is saved.
 */
function SubscriptionSheet({ sub, offerings, onClose, onChanged }: {
  sub: Sub; offerings: Offering[]; onClose: () => void; onChanged: () => void;
}) {
  const detail = useQuery({
    queryKey: ['subscription', sub.id],
    queryFn: () => apiGet<{ upcoming: string[]; billsOnDay: number; invoices: { id: number; number: string; issueDate: string; status: string; total: string; currency: string }[] }>(`/subscriptions/${sub.id}`),
  });
  const [form, setForm] = useState({
    nextBillDate: sub.nextBillDate,
    billingDay: String(sub.billsOnDay),
    intervalMonths: String(sub.intervalMonths),
    price: sub.isCustomPrice ? String(Number(sub.price)) : '',
    offeringId: String(sub.offeringId),
    startedOn: sub.startedOn,
    hasEnd: !!sub.endsOn,
    endsOn: sub.endsOn ?? '',
    autoSend: !!sub.autoSend,
    domain: sub.domain ?? '',
    notes: sub.notes ?? '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  // Moving the date carries the billing day with it, which is almost always meant.
  const setDate = (v: string) => setForm((f) => ({ ...f, nextBillDate: v, billingDay: v ? String(Number(v.slice(8, 10))) : f.billingDay }));

  const offering = offerings.find((o) => String(o.id) === form.offeringId);
  const listPrice = offering ? Number(offering.price) : Number(sub.listPrice);
  const day = Math.min(31, Math.max(1, Number(form.billingDay) || sub.billsOnDay));
  const months = Math.max(1, Number(form.intervalMonths) || 1);
  const preview = form.nextBillDate ? nextDates(form.nextBillDate, months, day, 4, form.hasEnd && form.endsOn ? form.endsOn : null) : [];
  const charge = form.price.trim() === '' ? listPrice : Number(form.price);

  const err = (e: unknown) => notify(e instanceof ApiError ? e.message : 'That did not save.', 'error');
  const save = useMutation({
    mutationFn: () => apiPatch(`/subscriptions/${sub.id}`, {
      nextBillDate: form.nextBillDate, billingDay: day, intervalMonths: months,
      price: form.price.trim() === '' ? null : Number(form.price),
      offeringId: Number(form.offeringId), startedOn: form.startedOn,
      endsOn: form.hasEnd && form.endsOn ? form.endsOn : null,
      autoSend: form.autoSend, domain: form.domain.trim() || null, notes: form.notes,
    }),
    onSuccess: () => { notify('Saved.', 'ok'); onChanged(); },
    onError: err,
  });
  const status = useMutation({
    mutationFn: (s: Subscription['status']) => apiPatch(`/subscriptions/${sub.id}`, { status: s }),
    onSuccess: () => { onChanged(); onClose(); },
    onError: err,
  });
  const debit = useMutation({
    mutationFn: (on: boolean) => apiPatch(`/subscriptions/${sub.id}`, { autoDebit: on }),
    onSuccess: onChanged, onError: err,
  });
  const billNow = useMutation({
    mutationFn: () => apiPost<{ billedFor: string; nextBillDate: string; documentId: number }>(`/subscriptions/${sub.id}/bill-now`),
    onSuccess: (r) => {
      notify(`Invoice made. The next one is ${fmtDate(r.nextBillDate)}.`, 'ok');
      onChanged();
      setForm((f) => ({ ...f, nextBillDate: r.nextBillDate }));
    },
    onError: err,
  });
  const del = useMutation({ mutationFn: () => apiDelete(`/subscriptions/${sub.id}`), onSuccess: () => { onChanged(); onClose(); }, onError: err });

  const active = sub.status === 'active';
  const label = 'mb-1 block text-xs text-slate-500';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-slate-800 bg-slate-950" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-label={`${sub.clientName}, ${sub.offeringName}`}>
        <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-slate-100">{sub.clientName}</h2>
              <p className="truncate text-xs text-slate-500">{sub.offeringName}{sub.domain ? `, ${sub.domain}` : ''}</p>
            </div>
            <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-800" aria-label="Close"><X size={16} /></button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {active && (
              <button className={`${btnSecondary} inline-flex items-center gap-1.5 px-3 py-1.5`} disabled={billNow.isPending}
                onClick={async () => {
                  if (await confirmDialog(`Make the ${fmtDate(sub.nextBillDate)} invoice now? The one after that will be on ${fmtDate(addMonths(sub.nextBillDate, sub.intervalMonths, sub.billsOnDay))}.`, { confirmLabel: 'Bill now' })) billNow.mutate();
                }}><Zap size={14} /> Bill now</button>
            )}
            {active && <button className={`${btnSecondary} inline-flex items-center gap-1.5 px-3 py-1.5`} onClick={() => status.mutate('paused')}><Pause size={14} /> Pause</button>}
            {!active && <button className={`${btnSecondary} inline-flex items-center gap-1.5 px-3 py-1.5`} onClick={() => status.mutate('active')}><Play size={14} /> {sub.status === 'paused' ? 'Resume' : 'Start again'}</button>}
            {sub.status !== 'canceled' && (
              <button className={`${btnSecondary} inline-flex items-center gap-1.5 px-3 py-1.5 hover:text-red-300`}
                onClick={async () => { if (await confirmDialog(`Cancel ${sub.clientName}'s ${sub.offeringName}? It stops billing. Hosting it pays for is suspended.`, { confirmLabel: 'Cancel it', danger: true })) status.mutate('canceled'); }}>
                <XCircle size={14} /> Cancel</button>
            )}
          </div>
          {sub.status === 'paused' && <p className="mt-2 text-xs text-amber-300">Paused. Resuming carries on from today; paused months are not billed.</p>}
        </div>

        <div className="space-y-6 p-4 sm:p-5">
          <section className="space-y-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-100"><CalendarClock size={15} /> When it bills</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={label} htmlFor="s-next">Next invoice</label>
                <input id="s-next" type="date" className={fieldClass} value={form.nextBillDate} min={todayIso()}
                  onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <label className={label} htmlFor="s-every">How often</label>
                <select id="s-every" className={fieldClass} value={form.intervalMonths} onChange={(e) => set('intervalMonths', e.target.value)}>
                  {[1, 2, 3, 6, 12].map((n) => <option key={n} value={n}>{every(n).long}</option>)}
                  {!EVERY[months] && <option value={months}>{every(months).long}</option>}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="s-day">Bills on day</label>
                <input id="s-day" type="number" min={1} max={31} className={fieldClass} value={form.billingDay}
                  onChange={(e) => set('billingDay', e.target.value)} />
                <p className="mt-1 text-[11px] text-slate-500">
                  The {ordinal(day)} of the month{day > 28 ? ', or the last day in shorter months' : ''}.
                </p>
              </div>
              <div>
                <label className={label} htmlFor="s-start">Client since</label>
                <input id="s-start" type="date" className={fieldClass} value={form.startedOn} onChange={(e) => set('startedOn', e.target.value)} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.hasEnd} onChange={(e) => set('hasEnd', e.target.checked)} />
              Stops on a set date
            </label>
            {form.hasEnd && (
              <div className="sm:w-1/2">
                <label className={label} htmlFor="s-end">Last day it runs</label>
                <input id="s-end" type="date" className={fieldClass} value={form.endsOn} min={form.startedOn} onChange={(e) => set('endsOn', e.target.value)} />
                <p className="mt-1 text-[11px] text-slate-500">After this it cancels itself. Use it for a fixed-term deal.</p>
              </div>
            )}
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-xs">
              <p className="mb-1 text-slate-500">{active ? 'It will bill on' : 'When resumed, it would bill on'}</p>
              {preview.length ? (
                <p className="text-slate-200">{preview.map((d) => fmtDate(d)).join(', ')}{form.hasEnd && form.endsOn && preview.length < 4 ? ', then it ends' : ', and so on'}</p>
              ) : <p className="text-slate-500">Pick a date.</p>}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">What they pay</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {offerings.length > 0 && (
                <div>
                  <label className={label} htmlFor="s-what">Plan</label>
                  <select id="s-what" className={fieldClass} value={form.offeringId} onChange={(e) => set('offeringId', e.target.value)}>
                    {!offering && <option value={sub.offeringId}>{sub.offeringName}</option>}
                    {offerings.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className={label} htmlFor="s-price">Price each time</label>
                <input id="s-price" type="number" step="0.01" min="0" className={fieldClass} value={form.price}
                  onChange={(e) => set('price', e.target.value)} placeholder={`${money(listPrice, sub.currency)} (list price)`} />
                <p className="mt-1 text-[11px] text-slate-500">Empty means the list price, and follows it when it changes. Before VAT.</p>
              </div>
            </div>
            <p className="text-xs text-slate-400">
              {Number.isFinite(charge) ? `${money(charge, sub.currency)} ${every(months).long.toLowerCase()}.` : ''} A change applies from the next invoice. Invoices already made stay as they are.
            </p>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">How the invoice goes out</h3>
            <div className="grid gap-2">
              <label className="flex items-start gap-2 text-sm text-slate-300">
                <input type="radio" name="send" className="mt-1" checked={!form.autoSend} onChange={() => set('autoSend', false)} />
                <span>As a draft for me to check and send<span className="block text-xs text-slate-500">It shows on Home when it is made.</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm text-slate-300">
                <input type="radio" name="send" className="mt-1" checked={form.autoSend} onChange={() => set('autoSend', true)} />
                <span>Emailed to them automatically<span className="block text-xs text-slate-500">Nothing for you to do each month.</span></span>
              </label>
            </div>
            <div className="rounded-lg border border-slate-800 p-3 text-sm">
              <label className="flex items-center justify-between gap-3 text-slate-300">
                <span>Charge their saved card each time
                  <span className={`block text-xs ${sub.hasCard ? 'text-green-300' : 'text-slate-500'}`}>
                    {sub.hasCard ? 'A card is saved.' : 'No card saved yet. One is saved when they pay an invoice for this online.'}
                  </span>
                </span>
                <input type="checkbox" checked={!!sub.autoDebit} disabled={debit.isPending || sub.status === 'canceled'}
                  onChange={async (e) => {
                    const on = e.target.checked;
                    if (on && !(await confirmDialog(`Charge ${sub.clientName}'s card automatically every time this bills? Only switch this on if they agreed to it.`, { confirmLabel: 'Switch it on' }))) return;
                    debit.mutate(on);
                  }} />
              </label>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">Other</h3>
            <div>
              <label className={label} htmlFor="s-domain">Website or domain</label>
              <input id="s-domain" className={fieldClass} value={form.domain} onChange={(e) => set('domain', e.target.value)} placeholder="Only for hosting" />
            </div>
            <div>
              <label className={label} htmlFor="s-notes">Private notes</label>
              <textarea id="s-notes" className={`${fieldClass} min-h-[72px] resize-y`} value={form.notes} onChange={(e) => set('notes', e.target.value)}
                placeholder="What was agreed. Never shown to the client." />
            </div>
          </section>

          <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-slate-800 bg-slate-950/95 px-4 py-3 sm:-mx-5 sm:px-5">
            <button className={btnPrimary} disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving' : 'Save changes'}</button>
            <button className={btnSecondary} onClick={onClose}>Close</button>
          </div>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-100">Invoices it has made</h3>
            {(detail.data?.invoices ?? []).length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : (
              <ul className="overflow-hidden rounded-lg border border-slate-800">
                {detail.data!.invoices.map((d) => (
                  <li key={d.id}>
                    <button onClick={() => navigateTo('billing', { open: String(d.id), doctype: 'invoice' })}
                      className="flex w-full items-center justify-between gap-3 border-b border-slate-800 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-slate-800/40">
                      <span><span className="text-slate-200">{d.number}</span> <span className="text-xs text-slate-500">{fmtShort(d.issueDate)}, {d.status === 'draft' ? 'draft' : d.status === 'paid' ? 'paid' : d.status === 'void' ? 'cancelled' : 'sent'}</span></span>
                      <span className="num text-slate-300">{money(d.total, d.currency)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <button className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-400"
            onClick={async () => { if (await confirmDialog('Delete this subscription record completely? Cancelling keeps the history; deleting does not.', { confirmLabel: 'Delete', danger: true })) del.mutate(); }}>
            <Trash2 size={13} /> Delete this record
          </button>
        </div>
      </div>
    </div>
  );
}
