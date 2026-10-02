import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, FileText, KanbanSquare,
  LayoutGrid, List, Receipt, Share2, Target, Plus, LifeBuoy,
} from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { money, moneyRound } from '../lib/money';
import { navigateTo } from '../lib/urlAction';
import { useAuth } from '../lib/auth';
import { confirmDialog, notify } from './ConfirmDialog';
import { OnboardingChecklist } from './OnboardingChecklist';
import { FocusMatrix } from './FocusMatrix';
import { CardDetail } from './CardDetail';
import { PaymentsModal } from './PaymentsModal';
import { DocActionSheet, useMoneyRefresh, type DocAction, type DocRef } from './DocActionSheet';
import { Skeleton, btnPrimary, btnSecondary } from './ui';
import type { BusinessSelection } from './BusinessSwitcher';
import type { Business } from '../lib/types';
import type { DocSummary } from './billingShared';

/**
 * Home: one list of what needs you, and the button that does each thing.
 *
 * The old Home was a matrix plus engine cards you had to interpret before you
 * could act. This is the list itself, Overdue first, and every row finishes its
 * job here: Chase chases, Paid records the money, Send sends. Nothing on this
 * screen is Home-only data; each row is an invoice, quote, task, meeting, deal
 * or post that lives somewhere else too, and opening it opens that thing.
 *
 * The four squares are still one click away for anyone who works that way.
 */

type PerCur = Record<string, number>;
type Group = 'overdue' | 'today' | 'week';
interface Item {
  key: string; group: Group; kind: string; title: string; sub: string;
  businessId: number | null; folderId: number | null; clientName: string | null;
  amount?: number; currency?: string; of?: number;
  docId?: number; docType?: string; docNumber?: string;
  taskId?: number; boardId?: number; eventId?: number; dealId?: number; postId?: number; supportId?: number;
  at?: string; allDay?: boolean;
}
interface HomeData {
  today: string;
  figures: {
    owed: PerCur; overdue: PerCur; comingIn: PerCur; moneyIn: PerCur;
    byMethod: { method: string; currency: string; amount: number }[];
    cameInToday: { docId: number; number: string; clientName: string; amount: number; currency: string; method: string }[];
  };
  items: Item[];
  didForYou?: { afterReminder: PerCur; afterReminderCount: number; autoInvoices: number; cardSelf: PerCur };
  counts: { overdue: number; today: number; week: number };
  perBusiness: { id: number; count: number }[];
}

/** Headline figures drop the cents; the exact amount is one click away. */
function perCur(m: PerCur, empty = 'Nothing'): string {
  const keys = Object.keys(m).filter((k) => Math.abs(m[k]!) > 0.001)
    .sort((a, b) => (a === 'ZAR' ? -1 : b === 'ZAR' ? 1 : a.localeCompare(b)));
  return keys.length ? keys.map((k) => moneyRound(m[k], k)).join(' and ') : empty;
}
const hasAny = (m: PerCur) => Object.values(m).some((v) => v > 0.001);

const GROUPS: { key: Group; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
];
const SHOW = 8;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function HomeView({ businessId, onNavigate, onPickBusiness }: {
  businessId: BusinessSelection;
  onNavigate: (v: string) => void;
  onPickBusiness: (v: BusinessSelection) => void;
}) {
  const { user } = useAuth();
  const refresh = useMoneyRefresh();
  const [mode, setMode] = useState<'list' | 'squares'>(() =>
    (localStorage.getItem('klippy.homeView') === 'squares' ? 'squares' : 'list'));
  const pickMode = (m: 'list' | 'squares') => { setMode(m); localStorage.setItem('klippy.homeView', m); };
  const bizParam = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['home', businessId],
    queryFn: () => apiGet<HomeData>(`/home${bizParam}`),
    refetchInterval: 5 * 60 * 1000,
  });
  // When one business is showing, say what the others are waiting on, so the
  // filter can never hide a fire.
  const everything = useQuery({
    queryKey: ['home', 'all'],
    queryFn: () => apiGet<HomeData>('/home'),
    enabled: businessId !== 'all',
  });
  const biz = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
    staleTime: 5 * 60 * 1000,
  });
  const businesses = biz.data?.businesses ?? [];
  const multi = businesses.length > 1;

  const [open, setOpen] = useState<Record<Group, boolean>>({ overdue: true, today: true, week: true });
  const [more, setMore] = useState<Record<Group, boolean>>({ overdue: false, today: false, week: false });
  const [sheet, setSheet] = useState<{ doc: DocRef; action: DocAction } | null>(null);
  const [paying, setPaying] = useState<DocSummary | null>(null);
  const [task, setTask] = useState<{ id: number; boardId: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const first = (user?.name ?? '').split(/\s+/)[0];
  const items = data?.items ?? [];
  const f = data?.figures;

  const docRef = (i: Item): DocRef => ({
    id: i.docId!, number: i.docNumber ?? '', clientName: i.clientName, amount: i.amount, currency: i.currency, type: i.docType,
  });
  const markPaid = (i: Item) => setPaying({
    id: i.docId!, type: (i.docType === 'quote' ? 'quote' : 'invoice'), number: i.docNumber ?? '',
    clientName: i.clientName ?? '', issueDate: data?.today ?? '', dueDate: null, status: 'sent',
    currency: i.currency ?? 'ZAR', total: String(i.of ?? i.amount ?? 0),
  });

  async function makeInvoice(i: Item) {
    setBusy(i.key);
    try {
      const r = await apiPost<{ document: { id: number; number: string } }>(`/documents/${i.docId}/convert`);
      refresh();
      notify(`${r.document.number} made from ${i.docNumber}, same lines and total. It is a draft until you send it.`);
      navigateTo('billing', { open: String(r.document.id), doctype: 'invoice' });
    } catch (e) {
      notify(e instanceof Error ? e.message : 'The invoice was not made.', 'error');
    } finally { setBusy(null); }
  }

  async function chaseAll() {
    const late = items.filter((i) => i.kind === 'invoice-late');
    const clients = [...new Set(late.map((i) => i.clientName).filter(Boolean))];
    const ok = await confirmDialog(
      `Chase ${clients.length} ${clients.length === 1 ? 'client' : 'clients'} about ${late.length} late ${late.length === 1 ? 'invoice' : 'invoices'}? `
      + `Each gets one email with their own invoices, how to pay, and their statement. Nobody sees anybody else.`,
      { confirmLabel: 'Chase them all' },
    );
    if (!ok) return;
    setBusy('chase-all');
    try {
      const r = await apiPost<{ sent: number; skipped?: unknown[] }>('/collections/chase',
        businessId === 'all' ? {} : { businessId });
      refresh();
      const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
      notify(`${r.sent} ${r.sent === 1 ? 'email' : 'emails'} sent.${skipped ? ` ${skipped} could not be emailed, usually because there is no email address on file.` : ''}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Nothing was sent.', 'error');
    } finally { setBusy(null); }
  }

  /** The one button that finishes a row, and where opening it goes. */
  function actions(i: Item) {
    const b = (label: string, run: () => void, primary = false) => (
      <button key={label} disabled={busy === i.key} onClick={run}
        className={`${primary ? btnPrimary : btnSecondary} min-h-10 px-3 py-1.5 text-xs sm:text-sm`}>{label}</button>
    );
    switch (i.kind) {
      case 'invoice-late': return [b('Chase', () => setSheet({ doc: docRef(i), action: 'chase' }), true), b('Paid', () => markPaid(i))];
      case 'invoice-due': return [b('Paid', () => markPaid(i), true)];
      case 'draft': return [b('Send', () => setSheet({ doc: docRef(i), action: 'send' }), true)];
      case 'quote-accepted': return [b('Make the invoice', () => makeInvoice(i), true)];
      case 'quote-expiring': return [b('Remind', () => setSheet({ doc: docRef(i), action: 'remind' }), true)];
      case 'task': return [b('Open', () => setTask({ id: i.taskId!, boardId: i.boardId! }))];
      case 'event': return [b('Open', () => onNavigate('calendar'))];
      case 'deal': return [b('Open deal', () => onNavigate('pipeline'))];
      case 'post': return [b('Open', () => navigateTo('social', { post: String(i.postId) }))];
      case 'support': return [b('Answer', () => openHelp(i), true)];
      default: return [];
    }
  }
  const openHelp = (i: Item) => navigateTo('clients', { client: String(i.folderId), help: String(i.supportId) });
  const openRow = (i: Item) => {
    if (i.supportId) openHelp(i);
    else if (i.docId) navigateTo('billing', { open: String(i.docId), doctype: i.docType ?? 'invoice' });
    else if (i.taskId && i.boardId) setTask({ id: i.taskId, boardId: i.boardId });
    else if (i.eventId) onNavigate('calendar');
    else if (i.dealId) onNavigate('pipeline');
    else if (i.postId) navigateTo('social', { post: String(i.postId) });
  };
  const icon = (i: Item) => {
    const cls = 'grid h-9 w-9 shrink-0 place-items-center rounded-lg';
    if (i.kind === 'invoice-late') return <span className={`${cls} bg-red-500/15 text-red-400`}><AlertTriangle size={16} /></span>;
    if (i.kind === 'invoice-due' || i.kind === 'draft') return <span className={`${cls} bg-amber-500/15 text-amber-400`}><Receipt size={16} /></span>;
    if (i.kind.startsWith('quote')) return <span className={`${cls} bg-[var(--accent-quiet)] text-violet-300`}><FileText size={16} /></span>;
    if (i.kind === 'event') return <span className={`${cls} bg-sky-500/15 text-sky-400`}><CalendarDays size={16} /></span>;
    if (i.kind === 'deal') return <span className={`${cls} bg-sky-500/15 text-sky-400`}><Target size={16} /></span>;
    if (i.kind === 'support') return <span className={`${cls} ${i.group === 'overdue' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'}`}><LifeBuoy size={16} /></span>;
    if (i.kind === 'post') return <span className={`${cls} bg-slate-800 text-slate-300`}><Share2 size={16} /></span>;
    return <span className={`${cls} ${i.group === 'overdue' ? 'bg-red-500/15 text-red-400' : 'bg-slate-800 text-slate-400'}`}><KanbanSquare size={16} /></span>;
  };
  const bizOf = (id: number | null) => businesses.find((x) => x.id === id);

  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const c = data?.counts;
  const others = businessId === 'all' ? [] : (everything.data?.perBusiness ?? [])
    .filter((p) => p.id !== businessId && p.count > 0)
    .map((p) => ({ ...p, name: bizOf(p.id)?.name ?? 'Another business' }));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-100">{greeting()}{first ? `, ${first}` : ''}</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {dateLine}.{c ? ` ${c.overdue} overdue, ${c.today} today, ${c.week} this week.` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-slate-700 p-0.5" role="group" aria-label="How Home is laid out">
              <button onClick={() => pickMode('list')} aria-pressed={mode === 'list'}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs ${mode === 'list' ? 'bg-[var(--accent-quiet)] text-slate-100' : 'text-slate-400'}`}>
                <List size={14} /> List
              </button>
              <button onClick={() => pickMode('squares')} aria-pressed={mode === 'squares'}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs ${mode === 'squares' ? 'bg-[var(--accent-quiet)] text-slate-100' : 'text-slate-400'}`}>
                <LayoutGrid size={14} /> Four squares
              </button>
            </div>
            <button className={btnSecondary} onClick={() => navigateTo('billing', { new: 'quote' })}>New quote</button>
            <button className={btnPrimary} onClick={() => navigateTo('billing', { new: 'invoice' })}>
              <span className="inline-flex items-center gap-1.5"><Plus size={15} /> New invoice</span>
            </button>
          </div>
        </div>

        <OnboardingChecklist onNavigate={onNavigate} />
        <ExamplesNotice />

        {others.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-sm text-slate-400">
            <span>Showing {bizOf(businessId as number)?.name ?? 'one business'} only. {others.map((o) => `${o.name} has ${o.count} ${o.count === 1 ? 'thing' : 'things'} waiting`).join(', ')}.</span>
            <button onClick={() => onPickBusiness('all')} className="text-[var(--accent)]">Show all businesses</button>
          </div>
        )}

        {/* The three figures, built so nothing is counted twice. */}
        {isLoading || !f ? (
          <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Figure label="Owed to you" value={perCur(f.owed, 'Nothing')} onClick={() => onNavigate('collections')}
              line={hasAny(f.overdue) ? `${perCur(f.overdue)} of it overdue` : 'None of it is late'} warn={hasAny(f.overdue)} />
            {/* On a phone the list is the point, so only the figure that drives it stays on top. */}
            <Figure label="Coming in, next 8 weeks" value={perCur(f.comingIn, 'Nothing due')} onClick={() => onNavigate('cashflow')} wide
              line="Invoices due in the next 8 weeks. What is already late is in Owed, not here." />
            <Figure label="Money in this month" value={perCur(f.moneyIn, 'Nothing yet')} onClick={() => onNavigate('billing')} wide
              line={f.byMethod.length ? f.byMethod.map((m) => `${money(m.amount, m.currency)} ${m.method === 'Other' ? 'other ways' : `by ${m.method}`}`).join(', ') : 'Payments you record show up here'} />
          </div>
        )}
        {f && f.cameInToday.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-slate-400">
            <CheckCircle2 size={15} className="text-emerald-400" /> Came in today:
            {f.cameInToday.map((p) => (
              <span key={`${p.docId}-${p.amount}`} className="num text-slate-200">{money(p.amount, p.currency)} from {p.clientName}</span>
            ))}
            <span className="text-slate-500">It is already in the figure above, not in your list.</span>
          </p>
        )}

        {data?.didForYou && <DidForYou d={data.didForYou} />}

        {error && <p className="text-sm text-red-400">Home could not load. {error instanceof Error ? error.message : ''}</p>}

        {mode === 'squares' ? (
          <FocusMatrix onNavigate={onNavigate} />
        ) : isLoading ? (
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center">
            <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-400" />
            <p className="font-medium text-slate-200">Nothing needs you right now.</p>
            <p className="mt-1 text-sm text-slate-500">Nothing is late, nothing is due today, and nobody is waiting on you. Go do the work.</p>
          </div>
        ) : (
          GROUPS.map((g) => {
            const rows = items.filter((i) => i.group === g.key);
            if (!rows.length) return null;
            const shown = more[g.key] ? rows : rows.slice(0, SHOW);
            const late = rows.filter((i) => i.kind === 'invoice-late').length;
            return (
              <section key={g.key} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))} aria-expanded={open[g.key]}
                    className="inline-flex min-h-9 items-center gap-1.5 font-display text-base font-semibold text-slate-100">
                    {open[g.key] ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
                    {g.label} <span className="num rounded-full bg-slate-800 px-2 text-xs font-normal text-slate-400">{rows.length}</span>
                  </button>
                  {g.key === 'overdue' && late > 1 && (
                    <button disabled={busy === 'chase-all'} onClick={chaseAll} className={`${btnSecondary} ml-auto min-h-9 px-3 py-1.5 text-xs`}>
                      Chase all {late}
                    </button>
                  )}
                </div>
                {open[g.key] && (
                  <div className="overflow-hidden rounded-xl border border-slate-800">
                    {shown.map((i) => {
                      const bz = bizOf(i.businessId);
                      return (
                        <div key={i.key} className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-900/30 px-3 py-2.5 last:border-b-0 sm:flex-nowrap">
                          {icon(i)}
                          <div className="min-w-0 flex-1">
                            <button onClick={() => openRow(i)} className="block max-w-full truncate text-left text-sm font-medium text-slate-100 hover:underline">{i.title}</button>
                            <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                              {i.clientName && (i.folderId
                                ? <button onClick={() => navigateTo('clients', { client: String(i.folderId) })} className="text-[var(--accent)] hover:underline">{i.clientName}</button>
                                : <span>{i.clientName}</span>)}
                              {multi && businessId === 'all' && bz && (
                                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: bz.color }} />{bz.name}</span>
                              )}
                              {i.at && <span>{whenText(i.at, i.allDay)}</span>}
                              {i.sub && <span>{i.sub}</span>}
                            </div>
                          </div>
                          {i.amount != null && i.currency && (
                            <div className="num shrink-0 text-right text-sm text-slate-200">
                              {money(i.amount, i.currency)}
                              {i.of != null && <span className="block text-[11px] text-slate-500">of {money(i.of, i.currency)}</span>}
                            </div>
                          )}
                          <div className="flex w-full shrink-0 justify-end gap-2 sm:w-auto">{actions(i)}</div>
                        </div>
                      );
                    })}
                    {rows.length > SHOW && (
                      <button onClick={() => setMore((m) => ({ ...m, [g.key]: !m[g.key] }))}
                        className="block min-h-11 w-full bg-slate-900/20 px-3 text-left text-sm text-[var(--accent)] hover:bg-slate-800/40">
                        {more[g.key] ? 'Show fewer' : `And ${rows.length - SHOW} more`}
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      {sheet && <DocActionSheet doc={sheet.doc} action={sheet.action} onClose={() => setSheet(null)} />}
      {paying && <PaymentsModal doc={paying} onClose={() => { setPaying(null); refresh(); }} />}
      {task && <CardDetail taskId={task.id} boardId={task.boardId} onClose={() => setTask(null)} />}
    </div>
  );
}

/**
 * What Klippy did for you this month, in plain money.
 *
 * The app never used to say what it was worth. This line does, and only with
 * things that actually happened: money paid after a reminder went out, invoices
 * the schedule raised by itself, card payments that recorded themselves. Parts
 * that are zero are left out, and the line hides when there is nothing to say.
 */
function DidForYou({ d }: { d: NonNullable<HomeData['didForYou']> }) {
  const bits: string[] = [];
  if (d.autoInvoices > 0) bits.push(`Sent ${d.autoInvoices} repeating ${d.autoInvoices === 1 ? 'invoice' : 'invoices'} by itself.`);
  if (hasAny(d.afterReminder)) bits.push(`${perCur(d.afterReminder)} came in on ${d.afterReminderCount} ${d.afterReminderCount === 1 ? 'invoice' : 'invoices'} after a reminder.`);
  if (hasAny(d.cardSelf)) bits.push(`${perCur(d.cardSelf)} was paid by card and recorded itself.`);
  if (!bits.length) return null;
  return (
    <p className="rounded-lg border border-[var(--accent-quiet)] bg-[var(--accent-quiet)]/40 px-3 py-2 text-sm text-slate-300">
      <span className="font-medium text-slate-100">This month Klippy: </span>{bits.join(' ')}
    </p>
  );
}

/**
 * Older workspaces still carry the example client, deals and prices that sign-up
 * used to add. The button to remove them lived on the old Home, so it moves here,
 * and it only shows while there is something to remove.
 */
function ExamplesNotice() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['samples'], queryFn: () => apiGet<{ present: boolean }>('/account/samples') });
  const [busy, setBusy] = useState(false);
  if (!data?.present) return null;
  async function clear() {
    const ok = await confirmDialog('Remove the example client, its boards, and the example deals and prices? Anything you made yourself, or renamed, stays.',
      { confirmLabel: 'Remove the examples' });
    if (!ok) return;
    setBusy(true);
    try {
      await apiPost('/account/clear-samples', {});
      qc.clear();
      notify('The examples are gone. What you see now is all yours.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'The examples could not be removed.', 'error');
    } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5 text-sm text-slate-300">
      <span className="flex-1">This workspace still has the example client, deals and prices it started with.</span>
      <button disabled={busy} onClick={clear} className={`${btnSecondary} min-h-9 px-3 py-1.5 text-xs`}>Remove the examples</button>
    </div>
  );
}

/** A meeting's day and time, in the reader's own timezone. */
function whenText(at: string, allDay?: boolean): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const day = sameDay ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return allDay ? `${day}, all day` : `${day}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function Figure({ label, value, line, warn, onClick, wide }: {
  label: string; value: string; line: string; warn?: boolean; onClick: () => void;
  /** Only shown from tablet width up. */
  wide?: boolean;
}) {
  return (
    <button onClick={onClick} className={`rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-left hover:bg-slate-800/40 ${wide ? 'hidden sm:block' : ''}`}>
      <div className="text-xs font-medium text-slate-400">{label}</div>
      <div className="num mt-1 font-display text-2xl font-bold text-slate-100">{value}</div>
      <div className={`mt-1 text-xs ${warn ? 'font-medium text-red-400' : 'text-slate-500'}`}>{line}</div>
    </button>
  );
}
