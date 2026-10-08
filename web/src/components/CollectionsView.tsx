import { useState } from 'react';
import { PaymentsModal } from './PaymentsModal';
import { navigateTo, useUrlAction } from '../lib/urlAction';
import type { DocSummary } from './billingShared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, AlertTriangle, FileText, MessageCircle, Search, Landmark } from 'lucide-react';
import { BankMatchModal } from './BankMatchModal';
import { apiGet, apiPost } from '../lib/api';
import { ErrorNote } from './ErrorNote';
import { StatementView } from './StatementView';
import type { BusinessSelection } from './BusinessSwitcher';
import { money } from '../lib/money';
import { Skeleton, SkeletonTile } from './ui';
import { notify, confirmDialog } from './ConfirmDialog';
import { Page, PageHeader, PageBody } from './PageHeader';

interface Item {
  id: number; number: string; clientName: string; clientEmail: string | null;
  /** A phone is on the client or one of its contacts: WhatsApp works. */
  hasPhone: boolean;
  businessId: number | null; folderId: number | null; currency: string; total: number; outstanding: number; dueDate: string | null;
  daysOverdue: number; lastReminderOn: string | null; suspended: boolean;
  remindersPaused?: boolean; nextReminder?: string | null;
  /** Carried over from the old system. */
  imported?: boolean;
}
type Filter = 'all' | 'mine' | 'risk' | 'unchased' | 'paused' | 'old';
const FILTERS: { key: Filter; label: string; test: (i: Item) => boolean }[] = [
  { key: 'all', label: 'Everything', test: () => true },
  { key: 'mine', label: 'Raised in Klippy', test: (i) => !i.imported },
  { key: 'risk', label: 'At risk', test: (i) => i.suspended },
  { key: 'unchased', label: 'Not chased yet', test: (i) => !i.lastReminderOn },
  { key: 'paused', label: 'Reminders paused', test: (i) => !!i.remindersPaused },
  { key: 'old', label: 'From the old system', test: (i) => !!i.imported },
];
/** The colour for how late something is: the older, the hotter. */
const AGE_TONE: Record<string, string> = {
  '1-30': 'bg-amber-400/70', '31-60': 'bg-orange-500/80', '61-90': 'bg-red-500/80', '90+': 'bg-red-700',
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sayDay = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
/** Last chased, and what happens next: the same plan the daily run follows. */
function reminderLine(i: Item): string {
  const last = i.lastReminderOn ? `last ${sayDay(i.lastReminderOn)}` : 'not chased yet';
  const next = i.remindersPaused ? 'paused' : i.nextReminder ? `next ${sayDay(i.nextReminder)}` : 'none scheduled';
  return `${last}, ${next}`;
}

interface Collections {
  items: Item[];
  summary: {
    count: number;
    /** One total per currency. Klippy never adds unlike currencies together. */
    byCurrency: { currency: string; outstanding: number; count: number }[];
    ageing?: { currency: string; buckets: { key: string; amount: number; count: number }[] }[];
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
  const [paying, setPaying] = useState<DocSummary | null>(null);
  const [matching, setMatching] = useState(false);
  const bizQ = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['collections', businessId],
    queryFn: () => apiGet<Collections>(`/collections${bizQ}`),
    retry: false,
  });

  // Which rows are ticked. Chasing sends ONE email per client per currency listing
  // everything they owe, with a pay link per invoice and their statement attached,
  // then records the reminder so the automatic schedule does not chase again today.
  const [sel, setSel] = useState<Set<number>>(new Set());
  // Finding someone, narrowing to the ones that need a different kind of attention,
  // and seeing it per client, which is how you actually ring people.
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // Home's "Sort them out" lands here already narrowed.
  useUrlAction('show', (v) => { if (FILTERS.some((f) => f.key === v)) setFilter(v as Filter); });
  const [byClient, setByClient] = useState(false);
  const q = query.trim().toLowerCase();
  const allItems = data?.items ?? [];
  const shown = allItems.filter((i) => FILTERS.find((f) => f.key === filter)!.test(i)
    && (!q || i.clientName.toLowerCase().includes(q) || i.number.toLowerCase().includes(q) || (i.clientEmail ?? '').toLowerCase().includes(q)));
  const narrowed = filter !== 'all' || !!q;
  const clients = [...shown.reduce((m, i) => {
    const key = `${i.folderId ?? i.clientName.toLowerCase()}:${i.currency}`;
    const g = m.get(key) ?? { key, name: i.clientName, folderId: i.folderId, currency: i.currency, items: [] as Item[] };
    g.items.push(i);
    return m.set(key, g);
  }, new Map<string, { key: string; name: string; folderId: number | null; currency: string; items: Item[] }>()).values()]
    .map((g) => ({ ...g, owed: g.items.reduce((t, i) => t + i.outstanding, 0), oldest: Math.max(...g.items.map((i) => i.daysOverdue)) }))
    .sort((a, b) => b.owed - a.owed);
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

  /**
   * Chasing emails real clients, so it asks first and says how many.
   *
   * "Chase all" sent immediately on one click, to every client with an overdue invoice and
   * an email address, and by SMS and WhatsApp as well when those are on. A reminder in a
   * client's inbox cannot be taken back, and a stray click on the most prominent button on
   * the screen could reach every debtor at once. Chasing ticked invoices asks too, since it
   * is the same button and the same consequence.
   */
  const confirmChase = async (only?: Item[]) => {
    // Ticked rows, else what the filter shows, else everything.
    // In bulk, invoices from the old system are left out unless that is the filter.
    const chosen = only ?? (sel.size ? allItems.filter((i) => sel.has(i.id)) : shown.filter((i) => filter === 'old' || !i.imported));
    const reachable = chosen.filter((i) => i.clientEmail);
    const clients = new Set(reachable.map((i) => (i.clientEmail ?? '').toLowerCase())).size;
    if (!reachable.length) {
      notify('Nothing to send. None of these invoices has an email address.', 'error');
      return;
    }
    const invoices = reachable.length === 1 ? '1 overdue invoice' : `${reachable.length} overdue invoices`;
    const who = clients === 1 ? '1 client' : `${clients} clients`;
    const yes = await confirmDialog(
      `Send payment reminders to ${who} about ${invoices}? They go out now, by email, and by SMS or WhatsApp too if those are switched on.`,
      { confirmLabel: 'Send reminders' });
    if (yes) chase.mutate(only ? reachable.map((i) => i.id) : sel.size ? [...sel] : narrowed ? reachable.map((i) => i.id) : undefined);
  };

  return (
    <Page>
      <PageHeader view="collections" title="Owed to you"
        subtitle="Overdue invoices, and who has been flagged for non-payment."
        actions={(
          <button onClick={() => setMatching(true)} title="Read your bank's CSV and record the EFTs that paid invoices"
            className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800 sm:min-h-9">
            <Landmark size={15} /> Match bank statement
          </button>
        )} />
      <PageBody className="space-y-5">
        {error && <ErrorNote error={error} onRetry={() => refetch()} />}

        {isLoading && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3"><SkeletonTile /><SkeletonTile /><SkeletonTile /></div>
            <Skeleton className="h-40" />
          </>
        )}

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

            {(data.summary.ageing ?? []).filter((a) => a.buckets.some((b) => b.amount > 0)).map((a) => {
              const total = a.buckets.reduce((t, b) => t + b.amount, 0) || 1;
              return (
                <div key={a.currency} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                  <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
                    How late{(data.summary.ageing ?? []).length > 1 ? ` (${a.currency})` : ''}
                  </div>
                  <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-800" aria-hidden>
                    {a.buckets.map((b) => b.amount > 0 && (
                      <div key={b.key} className={AGE_TONE[b.key]} style={{ width: `${(b.amount / total) * 100}%` }} />
                    ))}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {a.buckets.map((b) => (
                      <div key={b.key}>
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span className={`h-2 w-2 rounded-full ${AGE_TONE[b.key]}`} /> {b.key} days
                        </div>
                        <div className="num text-sm font-medium text-slate-200">{money(b.amount, a.currency)}</div>
                        <div className="text-[11px] text-slate-500">{b.count} invoice{b.count === 1 ? '' : 's'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {data.items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
                Nothing overdue. Everyone has paid, or is not late yet.
              </div>
            ) : (
              <>
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative min-w-0 flex-1 sm:max-w-xs">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Client or invoice number" aria-label="Find a client or invoice"
                    className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-900/70 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500 sm:min-h-9" />
                </label>
                <select value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setSel(new Set()); }} aria-label="Show"
                  className="min-h-10 rounded-lg border border-slate-700 bg-slate-900/70 px-2 text-sm text-slate-200 sm:min-h-9">
                  {FILTERS.map((f) => {
                    const n = allItems.filter(f.test).length;
                    return (f.key === 'all' || n > 0) && <option key={f.key} value={f.key}>{f.label} ({n})</option>;
                  })}
                </select>
                <div className="flex rounded-lg border border-slate-700 p-0.5 text-xs" role="group" aria-label="Group by">
                  <button onClick={() => setByClient(false)} aria-pressed={!byClient}
                    className={`min-h-9 rounded-md px-2.5 sm:min-h-8 ${!byClient ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>Invoices</button>
                  <button onClick={() => { setByClient(true); setSel(new Set()); }} aria-pressed={byClient}
                    className={`min-h-9 rounded-md px-2.5 sm:min-h-8 ${byClient ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>By client</button>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  {sel.size > 0
                    ? `${sel.size} selected`
                    : narrowed
                      ? `${shown.length} of ${allItems.length} shown.`
                      : byClient ? `${clients.length} client${clients.length === 1 ? '' : 's'} owe you.` : 'Tick invoices to chase a few, or chase everything owed in one go.'}
                </div>
                <button onClick={() => void confirmChase()} disabled={chase.isPending || shown.length === 0}
                  className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-50">
                  <Mail size={14} /> {chase.isPending ? 'Sending' : sel.size ? `Chase selected (${sel.size})` : narrowed ? `Chase these (${shown.length})` : 'Chase all'}
                </button>
              </div>

              {byClient && (
                <div className="overflow-hidden rounded-xl border border-slate-800">
                  {clients.map((c) => (
                    <div key={c.key} className="flex flex-wrap items-center gap-3 border-t border-slate-800 px-3 py-3 first:border-t-0">
                      <div className="min-w-0 flex-1">
                        {c.folderId
                          ? <button onClick={() => navigateTo('clients', { client: String(c.folderId) })} className="text-left text-sm font-medium text-slate-200 hover:text-[var(--accent)] hover:underline">{c.name}</button>
                          : <div className="text-sm font-medium text-slate-200">{c.name}</div>}
                        <div className="text-[11px] text-slate-500">
                          {c.items.length} invoice{c.items.length === 1 ? '' : 's'}, oldest{' '}
                          <span className={c.oldest >= 14 ? 'text-red-300' : 'text-amber-300'}>{c.oldest} days late</span>
                          {c.items.some((i) => i.suspended) && <span className="text-red-300">, at risk</span>}
                          {', '}{c.items.map((i) => i.number).join(', ')}
                        </div>
                      </div>
                      <div className="num text-right text-sm font-semibold text-slate-100">{money(c.owed, c.currency)}</div>
                      <div className="flex gap-1.5">
                        {c.folderId && (
                          <button onClick={() => setStatementFor(c.folderId)}
                            className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800">
                            <FileText size={12} /> Statement
                          </button>
                        )}
                        {c.items.some((i) => i.clientEmail) && (
                          <button onClick={() => void confirmChase(c.items)} disabled={chase.isPending}
                            title="One email listing everything this client owes, statement attached"
                            className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                            <Mail size={12} /> Chase
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {clients.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-500">Nothing matches.</div>}
                </div>
              )}
              {!byClient && <>
              <div className="hidden overflow-x-auto rounded-xl border border-slate-800 sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="w-8 px-3 py-2">
                        <input type="checkbox" aria-label="Select every invoice with an email address"
                          checked={sel.size > 0 && sel.size === shown.filter((i) => i.clientEmail).length}
                          onChange={(e) => setSel(e.target.checked
                            ? new Set(shown.filter((i) => i.clientEmail).map((i) => i.id))
                            : new Set())}
                          className="accent-violet-500" />
                      </th>
                      <th className="px-3 py-2">Invoice</th>
                      <th className="px-3 py-2">Client</th>
                      <th className="px-3 py-2 text-right">Outstanding</th>
                      <th className="px-3 py-2 text-right">Overdue</th>
                      <th className="px-3 py-2">Reminders</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i) => (
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
                            {i.imported && <span className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-400" title="Carried over from your old invoicing system. Not chased automatically.">old system</span>}
                            {i.suspended && (
                              <span className="flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                                <AlertTriangle size={10} /> At risk
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          {i.folderId
                            ? <button onClick={() => navigateTo('clients', { client: String(i.folderId) })} className="text-left text-slate-200 hover:text-[var(--accent)] hover:underline">{i.clientName}</button>
                            : <div className="text-slate-200">{i.clientName}</div>}
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
                        <td className="px-3 py-2.5 text-[11px] text-slate-500">{reminderLine(i)}</td>
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
                            <button onClick={() => setPaying({ id: i.id, type: 'invoice', number: i.number, clientName: i.clientName, issueDate: '', dueDate: i.dueDate, status: 'sent', currency: i.currency, total: String(i.total) } as DocSummary)}
                              title="Record money that came in against this invoice"
                              className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2 py-1 text-[11px] font-medium text-[var(--accent-ink)] hover:opacity-90">
                              Paid
                            </button>
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
                {shown.map((i) => (
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
                          {', '}{reminderLine(i)}
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
                      <button onClick={() => setPaying({ id: i.id, type: 'invoice', number: i.number, clientName: i.clientName, issueDate: '', dueDate: i.dueDate, status: 'sent', currency: i.currency, total: String(i.total) } as DocSummary)}
                        className="inline-flex min-h-10 items-center rounded-lg bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-ink)] hover:opacity-90">
                        Paid
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {shown.length === 0 && <div className="rounded-xl border border-slate-800 px-3 py-6 text-center text-sm text-slate-500">Nothing matches.</div>}
              </>}
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
      </PageBody>
      {matching && <BankMatchModal businessId={businessId === 'all' ? undefined : businessId} onClose={() => setMatching(false)} />}
      {statementFor && <StatementView folderId={statementFor} onClose={() => setStatementFor(null)} />}
      {paying && <PaymentsModal doc={paying} onClose={() => { setPaying(null); for (const k of ['collections', 'documents', 'home', 'client', 'clients']) qc.invalidateQueries({ queryKey: [k] }); }} />}
    </Page>
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
