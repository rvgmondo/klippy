import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, MessageCircle, Phone, Mail, MapPin, Pencil, FileText, Receipt, Users, Search, KanbanSquare, Target, AlertTriangle, Plus, Repeat, Paperclip, Download,
} from 'lucide-react';
import { ClientMessages, EmailComposer } from './ClientTalk';
import { apiGet, apiPatch } from '../lib/api';
import { money, moneyRound } from '../lib/money';
import { navigateTo, takeUrlParam } from '../lib/urlAction';
import { useAuth } from '../lib/auth';
import { PageHeader } from './PageHeader';
import { ClientDetails } from './ClientDetails';
import { notify } from './ConfirmDialog';
import { Card, EmptyState, Skeleton, btnPrimary, btnSecondary, fieldClass, fieldInlineClass } from './ui';
import type { BusinessSelection } from './BusinessSwitcher';
import type { Business, Folder } from '../lib/types';

/**
 * The Clients door: everyone you work for, and one page per client.
 *
 * The question this answers is the one asked when a client phones: what do they
 * owe, what is late, what are we busy with for them, and how do I reach them.
 * That used to take Billing, Collections, the folder tree, Contacts and a pencil
 * icon. The figures come from /clients, which uses the same balance rule as
 * every money screen, so this page and Money can never disagree.
 */

type PerCur = Record<string, number>;
interface ClientRow {
  id: number; name: string; color: string; businessId: number | null;
  email: string | null; phone: string | null; hasLogo: boolean;
  owed: PerCur; overdue: PerCur; lastActivity: string | null; dealOpen: boolean;
}
interface DocRow {
  id: number; type: 'quote' | 'invoice' | 'credit_note'; number: string; status: string;
  issueDate: string; dueDate: string | null; total: number; outstanding: number; currency: string;
  decision: string | null; lastReminderOn: string | null; late: boolean;
}
interface ClientPageData {
  client: {
    id: number; name: string; color: string; businessId: number | null; notes: string | null;
    billingEmail: string | null; billingPhone: string | null; billingAddress: string | null;
    billingVatNumber: string | null; hourlyRate: string | null; legalName: string | null;
    regNumber: string | null; companyType: string | null; website: string | null;
    paymentTermsDays: number | null; createdAt: string; remindersPaused?: boolean; clientSince?: string | null;
  };
  money: { owed: PerCur; overdue: PerCur; openInvoices: number; lateCount: number };
  documents: DocRow[];
  boards: { id: number; name: string; open: number; late: number }[];
  tasks: { id: number; title: string; dueDate: string | null; boardId: number }[];
  people: { id: number; name: string; email: string | null; phone: string | null; role: string | null }[];
  deals: { id: number; title: string; stage: string; value: number }[];
  subscriptions?: { id: number; status: 'active' | 'paused'; price: number; intervalMonths: number; nextBillDate: string; offeringName: string; domain: string | null }[];
  files?: { id: number; name: string; size: number; uploadedAt: string; taskTitle: string; boardId: number }[];
}

/** Each currency on its own, never added together. Whole units in lists, where width matters. */
function perCur(m: PerCur, empty = 'Nothing', round = false): string {
  const keys = Object.keys(m).filter((k) => Math.abs(m[k]!) > 0.001)
    .sort((a, b) => (a === 'ZAR' ? -1 : b === 'ZAR' ? 1 : a.localeCompare(b)));
  return keys.length ? keys.map((k) => (round ? moneyRound : money)(m[k], k)).join(' and ') : empty;
}
const hasAny = (m: PerCur) => Object.values(m).some((v) => v > 0.001);

/** wa.me wants the number in international form without the plus. */
function waLink(phone: string | null): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('0')) d = `27${d.slice(1)}`;
  return d.length >= 9 ? `https://wa.me/${d}` : null;
}

const fmtDay = (iso: string | null) => (iso
  ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  : '');

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

function Avatar({ name, color, big }: { name: string; color: string; big?: boolean }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-lg font-semibold text-slate-950 ${big ? 'h-12 w-12 text-base' : 'h-9 w-9 text-xs'}`}
      style={{ background: color || '#94a3b8' }}>
      {initials(name)}
    </span>
  );
}

function useBusinesses() {
  return useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
    staleTime: 5 * 60 * 1000,
  });
}

export function ClientsView({ businessId, clientId, onOpen, onBack }: {
  businessId: BusinessSelection;
  clientId: number | null;
  onOpen: (id: number) => void;
  onBack: () => void;
}) {
  if (clientId != null) return <ClientPage id={clientId} onBack={onBack} />;
  return <ClientList businessId={businessId} onOpen={onOpen} />;
}

// ---------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------

type Filter = 'all' | 'owes' | 'overdue' | 'deal';
type Sort = 'az' | 'owes' | 'recent';

function ClientList({ businessId, onOpen }: { businessId: BusinessSelection; onOpen: (id: number) => void }) {
  const { account } = useAuth();
  const word = account?.folderLabelPlural || 'Clients';
  const one = (account?.folderLabelSingular || 'Client').toLowerCase();
  const biz = useBusinesses();
  const businesses = biz.data?.businesses ?? [];
  const bizParam = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data, isLoading } = useQuery({
    queryKey: ['clients', businessId],
    queryFn: () => apiGet<{ clients: ClientRow[] }>(`/clients${bizParam}`),
  });
  const all = useMemo(() => data?.clients ?? [], [data]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('az');

  const counts = {
    all: all.length,
    owes: all.filter((c) => hasAny(c.owed)).length,
    overdue: all.filter((c) => hasAny(c.overdue)).length,
    deal: all.filter((c) => c.dealOpen).length,
  };
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const total = (m: PerCur) => Object.values(m).reduce((s, v) => s + v, 0);
    return all
      .filter((c) => !needle || `${c.name} ${c.email ?? ''} ${c.phone ?? ''}`.toLowerCase().includes(needle))
      .filter((c) => filter === 'all' || (filter === 'owes' ? hasAny(c.owed)
        : filter === 'overdue' ? hasAny(c.overdue) : c.dealOpen))
      .sort((a, b) => (sort === 'owes' ? total(b.owed) - total(a.owed)
        : sort === 'recent' ? (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '')
          : a.name.localeCompare(b.name)));
  }, [all, q, filter, sort]);

  const showBiz = businessId === 'all' && businesses.length > 1;
  const bizOf = (id: number | null) => businesses.find((b) => b.id === id);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader view="clients" title={word}
        subtitle={`Everyone you work for. Open a ${one} to see what they owe, what you are busy with, and how to reach them.`}
        actions={
          <button className={btnPrimary} onClick={() => navigateTo('clients', { 'new-client': '1' })}>
            <span className="inline-flex items-center gap-1.5"><Plus size={15} /> New {one}</span>
          </button>
        }>
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <label className="relative min-w-[12rem] flex-1 sm:max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input className={`${fieldClass} pl-8`} placeholder="Name, cell or email" value={q}
              onChange={(e) => setQ(e.target.value)} aria-label={`Find a ${one}`} />
          </label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
            {([['all', 'All'], ['owes', 'Owes you'], ['overdue', 'Overdue'], ['deal', 'Deal open']] as [Filter, string][])
              .map(([k, label]) => (
                <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k}
                  className={`min-h-9 rounded-full border px-3 text-xs ${filter === k
                    ? 'border-[var(--accent)] bg-[var(--accent-quiet)] text-slate-100'
                    : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>
                  {label} <span className="num ml-1 text-slate-500">{counts[k]}</span>
                </button>
              ))}
          </div>
          <select className={fieldInlineClass} value={sort} onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort">
            <option value="az">A to Z</option>
            <option value="owes">Owes you most</option>
            <option value="recent">Recently active</option>
          </select>
          <button className={`${btnSecondary} ml-auto inline-flex items-center gap-1.5 px-3 py-1.5`} disabled={rows.length === 0}
            onClick={() => {
              // The list as shown, for the accountant or a mailing list.
              const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
              const owedText = (m: PerCur) => Object.entries(m).filter(([, v]) => v > 0.001).map(([cur, v]) => `${cur} ${v.toFixed(2)}`).join('; ');
              const csv = [['Name', 'Email', 'Cell', 'Owes', 'Overdue', ...(showBiz ? ['Business'] : [])],
                ...rows.map((c) => [c.name, c.email ?? '', c.phone ?? '', owedText(c.owed), owedText(c.overdue), ...(showBiz ? [bizOf(c.businessId)?.name ?? ''] : [])])]
                .map((r) => r.map(cell).join(',')).join(String.fromCharCode(13, 10));
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
              a.download = `${word.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }}>
            <Download size={14} /> Export
          </button>
        </div>
      </PageHeader>

      <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
        {isLoading ? (
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : all.length === 0 ? (
          <EmptyState icon={<Users size={28} />} title={`No ${word.toLowerCase()} yet`}
            body={`Add your first ${one}. A name and a cell number is enough to send them a quote.`}
            actionLabel={`New ${one}`} onAction={() => navigateTo('clients', { 'new-client': '1' })} />
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">Nobody matches that.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-800">
            {rows.map((c) => {
              const wa = waLink(c.phone);
              const b = bizOf(c.businessId);
              return (
                <div key={c.id} className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/30 px-3 py-2.5 last:border-b-0 hover:bg-slate-800/40">
                  <button onClick={() => onOpen(c.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Avatar name={c.name} color={c.color} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-100">{c.name}</span>
                      <span className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                        {showBiz && b && (
                          <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />{b.name}
                          </span>
                        )}
                        {c.dealOpen && <span className="text-sky-400">Deal open</span>}
                        {c.lastActivity && <span>Last {fmtDay(c.lastActivity)}</span>}
                        {!c.phone && !c.email && <span>No cell or email yet</span>}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-right sm:block">
                      <span className="num block text-sm text-slate-200">{hasAny(c.owed) ? perCur(c.owed, '', true) : ''}</span>
                      {hasAny(c.overdue) && <span className="num block text-xs text-red-400">{perCur(c.overdue, '', true)} late</span>}
                    </span>
                  </button>
                  {/* On a phone the amount moves under the button row, so it never squeezes the name. */}
                  <span className="shrink-0 text-right sm:hidden">
                    {hasAny(c.owed) && <span className="num block text-xs text-slate-200">{perCur(c.owed, '', true)}</span>}
                    {hasAny(c.overdue) && <span className="num block text-[11px] text-red-400">late</span>}
                  </span>
                  {wa ? (
                    <a href={wa} target="_blank" rel="noopener" title={`WhatsApp ${c.name}`}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-emerald-400 hover:bg-slate-800">
                      <MessageCircle size={17} />
                    </a>
                  ) : <span className="h-10 w-10 shrink-0" />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// One client
// ---------------------------------------------------------------------------------

type Tab = 'overview' | 'money' | 'work' | 'people' | 'files' | 'messages';

function ClientPage({ id, onBack }: { id: number; onBack: () => void }) {
  const { account } = useAuth();
  const qc = useQueryClient();
  const word = account?.folderLabelPlural || 'Clients';
  const biz = useBusinesses();
  const { data, isLoading, error } = useQuery({
    queryKey: ['client', id],
    queryFn: () => apiGet<ClientPageData>(`/clients/${id}`),
  });
  // The edit form already exists; it wants the folder row, which the tree has cached.
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const [editing, setEditing] = useState(false);
  // A link from a help notification (?help=12) opens straight on that conversation.
  // Read once, then taken off the address so it does not follow you to the next client.
  const [helpId] = useState(() => Number(new URLSearchParams(window.location.search).get('help')) || null);
  useEffect(() => { if (helpId) takeUrlParam('help'); }, [helpId]);
  const [tab, setTab] = useState<Tab>(helpId ? 'messages' : 'overview');
  const [writing, setWriting] = useState(false);
  const help = useQuery({
    queryKey: ['client-help', id],
    queryFn: () => apiGet<{ requests: { status: string }[] }>(`/support?folderId=${id}`),
  });
  const waiting = (help.data?.requests ?? []).filter((r) => r.status === 'open').length;

  if (isLoading) {
    return <div className="mx-auto max-w-6xl space-y-3 p-6"><Skeleton className="h-12 w-64" /><Skeleton className="h-40 w-full" /></div>;
  }
  if (error || !data) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <EmptyState title="This client is not here any more"
          body="It may have been deleted, or it belongs to a business you cannot see." actionLabel={`Back to ${word}`} onAction={onBack} />
      </div>
    );
  }

  const c = data.client;
  const b = biz.data?.businesses.find((x) => x.id === c.businessId);
  const multi = (biz.data?.businesses.length ?? 0) > 1;
  const phone = c.billingPhone || data.people.find((p) => p.phone)?.phone || null;
  const email = c.billingEmail || data.people.find((p) => p.email)?.email || null;
  const wa = waLink(phone);
  const folder = folders.data?.folders.find((f) => f.id === id);
  const newDoc = (type: 'invoice' | 'quote') => navigateTo('billing', { new: type, folder: String(id) });
  const toggleReminders = async (paused: boolean) => {
    try {
      await apiPatch(`/clients/${id}/reminders`, { paused });
      void qc.invalidateQueries({ queryKey: ['client', id] });
      void qc.invalidateQueries({ queryKey: ['collections'] });
      notify(paused ? `No more automatic reminders to ${c.name}. Chase still works when you press it.` : `Reminders to ${c.name} are back on.`, 'ok');
    } catch (e) { notify(e instanceof Error ? e.message : 'That did not save.', 'error'); }
  };
  const openDoc = (d: DocRow) => navigateTo('billing', { open: String(d.id), doctype: d.type });
  const openBoard = (boardId: number) => navigateTo('board', { board: String(boardId) });

  const tabs: { key: Tab; label: string; n?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'money', label: 'Money', n: data.documents.length },
    { key: 'work', label: 'Work', n: data.tasks.length },
    { key: 'people', label: 'People', n: data.people.length },
    { key: 'files', label: 'Files', n: data.files?.length || undefined },
    { key: 'messages', label: 'Messages', n: waiting || undefined },
  ];
  const addresses = [...new Set([c.billingEmail, ...data.people.map((p) => p.email)]
    .filter((x): x is string => !!x).map((x) => x.trim()))];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-20 shrink-0 border-b border-slate-800 bg-slate-950/90 px-4 pt-3 backdrop-blur sm:px-6">
        <div className="mx-auto max-w-6xl">
          <button onClick={onBack} className="mb-2 inline-flex min-h-9 items-center gap-1 text-sm text-[var(--accent)]">
            <ArrowLeft size={15} /> {word}
          </button>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar name={c.name} color={c.color} big />
              <div className="min-w-0">
                <h1 className="truncate font-display text-xl font-bold text-slate-100 sm:text-2xl">{c.name}</h1>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                  {c.legalName && c.legalName !== c.name && <span>{c.legalName}</span>}
                  {multi && b && (
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />{b.name}
                    </span>
                  )}
                  {data.deals.some((d) => d.stage !== 'won' && d.stage !== 'lost') && <span className="text-sky-400">Deal open</span>}
                  <span>{`${(account?.folderLabelSingular || 'Client')} since ${new Date(c.clientSince ? `${c.clientSince.slice(0, 10)}T00:00:00` : c.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}</span>
                </p>
              </div>
            </div>
            {/* The four things you do for a client, thumb-sized on a phone. */}
            <div className="grid w-full auto-cols-fr grid-flow-col gap-2 sm:flex sm:w-auto">
              {wa ? (
                <a href={wa} target="_blank" rel="noopener"
                  className="flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-500 sm:flex-row sm:gap-1.5 sm:text-sm">
                  <MessageCircle size={15} /> WhatsApp
                </a>
              ) : null}
              {phone && (
                <a href={`tel:${phone}`} className={`${btnSecondary} flex min-h-11 flex-col items-center justify-center gap-0.5 px-3 text-xs sm:hidden`}>
                  <Phone size={15} /> Call
                </a>
              )}
              <button onClick={() => setWriting(true)} className={`${btnSecondary} flex min-h-11 flex-col items-center justify-center gap-0.5 px-3 text-xs sm:flex-row sm:gap-1.5 sm:text-sm`}>
                <Mail size={15} /> Email
              </button>
              <button onClick={() => newDoc('quote')} className={`${btnSecondary} flex min-h-11 flex-col items-center justify-center gap-0.5 px-3 text-xs sm:flex-row sm:gap-1.5 sm:text-sm`}>
                <FileText size={15} /> Quote
              </button>
              <button onClick={() => newDoc('invoice')} className={`${btnPrimary} flex min-h-11 flex-col items-center justify-center gap-0.5 px-3 text-xs sm:flex-row sm:gap-1.5 sm:text-sm`}>
                <Receipt size={15} /> Invoice
              </button>
            </div>
          </div>
          <nav className="-mb-px mt-3 flex gap-1 overflow-x-auto" aria-label="Client sections">
            {tabs.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}
                className={`shrink-0 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm ${tab === t.key
                  ? 'border-[var(--accent)] font-medium text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
                {t.label}{t.n ? <span className="num ml-1.5 text-xs text-slate-500">{t.n}</span> : null}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
        {tab === 'overview' && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-4">
              <Card>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-semibold text-slate-100">Reach them</h2>
                  {folder && <button onClick={() => setEditing(true)} className={`${btnSecondary} inline-flex items-center gap-1.5 px-3 py-1.5`}><Pencil size={13} /> Edit</button>}
                </div>
                <dl className="divide-y divide-slate-800 text-sm">
                  <Row label="Cell">
                    {phone ? <span className="flex flex-wrap items-center gap-2"><span className="num">{phone}</span>
                      <a href={`tel:${phone}`} className="text-xs text-[var(--accent)]">Call</a>
                      {wa && <a href={wa} target="_blank" rel="noopener" className="text-xs text-emerald-400">WhatsApp</a>}</span>
                      : <Missing onAdd={folder ? () => setEditing(true) : undefined}>No cell number yet</Missing>}
                  </Row>
                  <Row label="Invoices go to">
                    {email ? <a href={`mailto:${email}`} className="inline-flex items-center gap-1.5 text-slate-200"><Mail size={13} /> {email}</a>
                      : <Missing onAdd={folder ? () => setEditing(true) : undefined}>No email yet, so invoices cannot be emailed</Missing>}
                  </Row>
                  {c.billingAddress && (
                    <Row label="Address">
                      <span className="flex flex-wrap items-center gap-2"><span className="whitespace-pre-line">{c.billingAddress}</span>
                        <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.billingAddress)}`} target="_blank" rel="noopener"
                          className="inline-flex items-center gap-1 text-xs text-[var(--accent)]"><MapPin size={12} /> Open in Maps</a></span>
                    </Row>
                  )}
                  <Row label="Pays within">
                    {c.paymentTermsDays != null ? `${c.paymentTermsDays} days` : <span className="text-slate-500">{b?.defaultDueDays ?? 14} days, from {b?.name ?? 'the business'} terms</span>}
                  </Row>
                  {c.billingVatNumber && <Row label="Their VAT number"><span className="num">{c.billingVatNumber}</span></Row>}
                  <Row label="Reminders">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={c.remindersPaused ? 'text-amber-300' : 'text-slate-200'}>
                        {c.remindersPaused ? 'Paused. Nothing is sent to them automatically.' : 'Sent automatically when an invoice is due or late'}
                      </span>
                      <button className="text-xs text-[var(--accent)]" onClick={() => toggleReminders(!c.remindersPaused)}>
                        {c.remindersPaused ? 'Turn back on' : 'Pause for this client'}
                      </button>
                    </span>
                  </Row>
                </dl>
              </Card>

              <Card>
                <h2 className="mb-3 font-semibold text-slate-100">What they owe</h2>
                {hasAny(data.money.owed) ? (
                  <>
                    <div className="num font-display text-3xl font-bold text-slate-100">{perCur(data.money.owed)}</div>
                    <p className="mt-1 text-sm text-slate-400">
                      {data.money.openInvoices} {data.money.openInvoices === 1 ? 'invoice' : 'invoices'} still open.
                      {hasAny(data.money.overdue) && (
                        <span className="text-red-400"> {perCur(data.money.overdue)} of it is late, over {data.money.lateCount} {data.money.lateCount === 1 ? 'invoice' : 'invoices'}.</span>
                      )}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {hasAny(data.money.overdue) && (
                        <button className={btnPrimary} onClick={() => navigateTo('collections')}>Chase them</button>
                      )}
                      <button className={btnSecondary} onClick={() => setTab('money')}>See the invoices</button>
                    </div>
                    <p className="mt-3 text-[11px] text-slate-500">The same figure as Money and Owed to you. They are all worked out from the same invoices.</p>
                  </>
                ) : (
                  <p className="text-sm text-slate-400">Nothing. Every invoice they have is settled.</p>
                )}
              </Card>

              {c.notes && (
                <Card>
                  <h2 className="mb-2 font-semibold text-slate-100">Notes</h2>
                  <p className="whitespace-pre-line text-sm text-slate-300">{c.notes}</p>
                </Card>
              )}
            </div>

            <div className="space-y-4">
              <Card>
                <h2 className="mb-2 flex items-center gap-2 font-semibold text-slate-100"><KanbanSquare size={15} /> Work</h2>
                {data.boards.length === 0 ? (
                  <p className="text-sm text-slate-500">No boards for them yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {data.boards.map((bd) => (
                      <li key={bd.id}>
                        <button onClick={() => openBoard(bd.id)} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-800/50">
                          <span className="truncate text-slate-200">{bd.name}</span>
                          <span className="num shrink-0 text-xs text-slate-500">
                            {bd.open} open{bd.late ? <span className="text-red-400">, {bd.late} late</span> : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="flex items-center gap-2 font-semibold text-slate-100"><Repeat size={15} /> On repeat</h2>
                  <button onClick={() => navigateTo('subscriptions')} className="text-xs text-[var(--accent)]">All subscriptions</button>
                </div>
                {(data.subscriptions ?? []).length === 0 ? (
                  <p className="text-sm text-slate-500">Nothing billed to them on repeat.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {data.subscriptions!.map((x) => (
                      <li key={x.id} className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block truncate text-slate-200">{x.offeringName}{x.domain ? `, ${x.domain}` : ''}</span>
                          <span className="block text-xs text-slate-500">
                            {x.status === 'paused' ? 'Paused' : `Next bill ${fmtDay(x.nextBillDate)}`}
                          </span>
                        </span>
                        <span className="num shrink-0 text-right text-slate-300">
                          {money(x.price, b?.currency ?? account?.currency ?? 'ZAR')}
                          <span className="block text-[11px] text-slate-500">{x.intervalMonths === 1 ? 'a month' : x.intervalMonths === 12 ? 'a year' : `every ${x.intervalMonths} months`}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              {(c.legalName || c.regNumber || c.website) && (
                <Card>
                  <h2 className="mb-2 font-semibold text-slate-100">Company</h2>
                  <dl className="space-y-1.5 text-sm">
                    {c.legalName && <div><dt className="text-xs text-slate-500">Registered name</dt><dd className="text-slate-200">{c.legalName}</dd></div>}
                    {c.regNumber && <div><dt className="text-xs text-slate-500">Registration number</dt><dd className="num text-slate-200">{c.regNumber}</dd></div>}
                    {c.website && <div><dt className="text-xs text-slate-500">Website</dt><dd><a href={c.website.startsWith('http') ? c.website : `https://${c.website}`} target="_blank" rel="noopener" className="text-[var(--accent)]">{c.website}</a></dd></div>}
                  </dl>
                </Card>
              )}
              {data.deals.length > 0 && (
                <Card>
                  <h2 className="mb-2 flex items-center gap-2 font-semibold text-slate-100"><Target size={15} /> Deals</h2>
                  <ul className="space-y-1 text-sm">
                    {data.deals.map((d) => (
                      <li key={d.id} className="flex justify-between gap-2">
                        <span className="truncate text-slate-200">{d.title}</span>
                        <span className="shrink-0 text-xs text-slate-500">{STAGE[d.stage] ?? d.stage}</span>
                      </li>
                    ))}
                  </ul>
                  <button onClick={() => navigateTo('pipeline')} className="mt-2 text-xs text-[var(--accent)]">Open Deals</button>
                </Card>
              )}
            </div>
          </div>
        )}

        {tab === 'money' && (
          data.documents.length === 0 ? (
            <EmptyState icon={<Receipt size={28} />} title="Nothing billed yet"
              body="Their quotes, invoices and credit notes will all be listed here."
              actionLabel="New quote" onAction={() => newDoc('quote')} />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-800">
              {data.documents.map((d) => (
                <button key={d.id} onClick={() => openDoc(d)}
                  className="flex w-full items-center gap-3 border-b border-slate-800 bg-slate-900/30 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-800/40">
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${d.late ? 'bg-red-500/15 text-red-400' : 'bg-slate-800 text-slate-400'}`}>
                    {d.late ? <AlertTriangle size={15} /> : d.type === 'quote' ? <FileText size={15} /> : <Receipt size={15} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-100">{d.number}</span>
                    <span className="block text-xs text-slate-500">{docState(d)}</span>
                  </span>
                  <span className="num shrink-0 text-right text-sm text-slate-200">
                    {d.type === 'credit_note' ? `-${money(d.total, d.currency)}`
                      : d.type === 'invoice' && d.outstanding > 0.001 && d.outstanding < d.total - 0.001
                        ? <>{money(d.outstanding, d.currency)}<span className="block text-[11px] text-slate-500">of {money(d.total, d.currency)}</span></>
                        : money(d.total, d.currency)}
                  </span>
                </button>
              ))}
            </div>
          )
        )}

        {tab === 'work' && (
          data.tasks.length === 0 ? (
            <EmptyState icon={<KanbanSquare size={28} />} title="Nothing open for them"
              body={data.boards.length ? 'Every task on their boards is done.' : 'Give them a board from Work when there is something to do.'} />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-800">
              {data.tasks.map((t) => {
                const late = !!t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10);
                return (
                  <button key={t.id} onClick={() => openBoard(t.boardId)}
                    className="flex w-full items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/30 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-800/40">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-slate-100">{t.title}</span>
                      <span className="block text-xs text-slate-500">{data.boards.find((x) => x.id === t.boardId)?.name}</span>
                    </span>
                    <span className={`shrink-0 text-xs ${late ? 'text-red-400' : 'text-slate-500'}`}>
                      {t.dueDate ? (late ? `Late, ${fmtDay(t.dueDate)}` : fmtDay(t.dueDate)) : 'No date'}
                    </span>
                  </button>
                );
              })}
            </div>
          )
        )}

        {tab === 'people' && (
          data.people.length === 0 ? (
            <EmptyState icon={<Users size={28} />} title="No people yet"
              body="Add the person you deal with, so their cell and email are one tap away."
              actionLabel={folder ? 'Edit client details' : undefined} onAction={folder ? () => setEditing(true) : undefined} />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-800">
              {data.people.map((p) => {
                const pwa = waLink(p.phone);
                return (
                  <div key={p.id} className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/30 px-3 py-2.5 last:border-b-0">
                    <Avatar name={p.name} color="#94a3b8" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-100">{p.name}</span>
                      <span className="block truncate text-xs text-slate-500">{[p.role, p.phone, p.email].filter(Boolean).join(', ')}</span>
                    </span>
                    {pwa && <a href={pwa} target="_blank" rel="noopener" className="grid h-10 w-10 place-items-center rounded-lg text-emerald-400 hover:bg-slate-800" title="WhatsApp"><MessageCircle size={17} /></a>}
                    {p.phone && <a href={`tel:${p.phone}`} className="grid h-10 w-10 place-items-center rounded-lg text-slate-300 hover:bg-slate-800" title="Call"><Phone size={16} /></a>}
                  </div>
                );
              })}
            </div>
          )
        )}

        {tab === 'files' && (
          (data.files ?? []).length === 0 ? (
            <EmptyState icon={<Paperclip size={28} />} title="No files yet"
              body="Files attached to cards on their boards show up here, so you never have to remember which card they went on." />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-800">
              {data.files!.map((f) => (
                <div key={f.id} className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/30 px-3 py-2.5 last:border-b-0">
                  <Paperclip size={15} className="shrink-0 text-slate-500" />
                  <span className="min-w-0 flex-1">
                    <a href={`/api/v1/files/${f.id}/download`} className="block truncate text-sm text-slate-100 hover:text-[var(--accent)] hover:underline">{f.name}</a>
                    <button onClick={() => openBoard(f.boardId)} className="block truncate text-left text-xs text-slate-500 hover:text-slate-300">
                      On "{f.taskTitle}", {data.boards.find((x) => x.id === f.boardId)?.name ?? 'a board'}
                    </button>
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">{fmtDay(f.uploadedAt.slice(0, 10))}</span>
                </div>
              ))}
            </div>
          )
        )}

        {tab === 'messages' && (
          <ClientMessages clientId={id} openHelpId={helpId} onWrite={() => setWriting(true)} />
        )}
      </div>

      {editing && folder && <ClientDetails folder={folder} onClose={() => setEditing(false)} />}
      {writing && <EmailComposer clientId={id} clientName={c.name} addresses={addresses} onClose={() => setWriting(false)} />}
    </div>
  );
}

const STAGE: Record<string, string> = { lead: 'New', contacted: 'Talking', proposal: 'Proposal sent', won: 'Won', lost: 'Lost' };

function docState(d: DocRow): string {
  const kind = d.type === 'quote' ? 'Quote' : d.type === 'credit_note' ? 'Credit note' : 'Invoice';
  if (d.status === 'draft') return `${kind}, draft. They have not seen it.`;
  if (d.status === 'void') return `${kind}, cancelled`;
  if (d.type === 'quote') {
    if (d.decision === 'accepted' || d.status === 'accepted') return 'Quote, accepted';
    if (d.decision === 'declined') return 'Quote, declined';
    return `Quote, sent ${fmtDay(d.issueDate)}${d.dueDate ? `, good until ${fmtDay(d.dueDate)}` : ''}`;
  }
  if (d.type === 'credit_note') return `Credit note, ${fmtDay(d.issueDate)}`;
  if (d.status === 'paid' || d.outstanding <= 0.001) return `Invoice, paid`;
  if (d.late) return `Invoice, late since ${fmtDay(d.dueDate)}${d.lastReminderOn ? `, chased ${fmtDay(d.lastReminderOn)}` : ''}`;
  return `Invoice, due ${fmtDay(d.dueDate)}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs text-slate-500 sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-slate-200">{children}</dd>
    </div>
  );
}

function Missing({ children, onAdd }: { children: React.ReactNode; onAdd?: () => void }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-slate-500">
      {children}
      {onAdd && <button onClick={onAdd} className="text-xs text-[var(--accent)]">Add it</button>}
    </span>
  );
}
