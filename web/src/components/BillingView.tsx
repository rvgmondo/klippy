import { useEffect, useState } from 'react';
import { confirmDialog, promptDialog, notify } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X, Pencil, Clock, DollarSign, MoreHorizontal, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../lib/api';
import { ClientPicker } from './ClientPicker';
// iso() builds a date from LOCAL parts. toISOString() converts to UTC first, so
// anywhere east of Greenwich it can hand back yesterday.
import { iso } from '../lib/dates';
import type { Folder } from '../lib/types';
import { useUrlAction, takeUrlParam } from '../lib/urlAction';
import { EmptyState, Skeleton } from './ui';
import { Modal } from './Modal';
import { Menu } from './Menu';
import { PrintView } from './InvoicePrintView';
import { PaymentsModal } from './PaymentsModal';
import { Page, PageHeader, PageBody } from './PageHeader';
import type { BusinessSelection } from './BusinessSwitcher';
import { fieldClass } from './ui';
import {
  money, STATUS_COLOR, type TreeFolder, type DocType, type Status, type DocSummary,
  type Line, type DiscountType, type DepositType, type FullDoc,
} from './billingShared';

const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * The statuses a person may pick for one document.
 *
 * "accepted" is a quote's answer and means nothing on an invoice; set there, it dropped
 * the invoice off every screen that chases money. So an invoice offers draft and sent,
 * and a quote adds accepted. Nothing issued offers draft, which the server refuses.
 *
 * The row's CURRENT status is always included, even when it is no longer allowed. An
 * invoice already stuck at "accepted" from before this change would otherwise render a
 * select whose value matches no option: the browser shows "sent", choosing "sent" fires no
 * change, and the bad state could never be corrected from the screen.
 */
function statusOptions(type: string, current: Status): Status[] {
  const allowed: Status[] = type === 'quote'
    ? (current === 'draft' ? ['draft', 'sent', 'accepted'] : ['sent', 'accepted'])
    : (current === 'draft' ? ['draft', 'sent'] : ['sent']);
  return allowed.includes(current) ? allowed : [current, ...allowed];
}

export function BillingView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<DocType>('invoice');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [initialFolder, setInitialFolder] = useState<number | null>(null);

  // The palette and the client action row hand this view an intent through the
  // URL: open a fresh invoice or quote, optionally already pointed at a client.
  useUrlAction('new', (v) => {
    if (v !== 'invoice' && v !== 'quote') return;
    const f = takeUrlParam('folder');
    setInitialFolder(f ? Number(f) : null);
    setTab(v);
    setEditing('new');
  });
  const [printing, setPrinting] = useState<number | null>(null);
  const [paying, setPaying] = useState<DocSummary | null>(null);
  const bizParam = businessId === 'all' ? '' : `&businessId=${businessId}`;
  const newBusinessId = businessId === 'all' ? undefined : businessId;

  const { data, isLoading } = useQuery({
    queryKey: ['documents', tab, businessId],
    queryFn: () => apiGet<{ documents: DocSummary[] }>(`/documents?type=${tab}${bizParam}`),
  });
  const docs = data?.documents ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['documents'] });

  // Only offer "Pay online" when PayFast is actually switched on for what is on screen.
  // This used to read only the workspace gateway, so a business with a PayFast account of
  // its own never got the button. Keyed under 'payfast' so saving payment settings
  // refreshes it.
  const payfast = useQuery({
    queryKey: ['payfast', 'mode', businessId],
    queryFn: () => apiGet<{ live: boolean; test: boolean }>(
      `/payfast/mode${businessId === 'all' ? '' : `?businessId=${businessId}`}`),
  });
  const payfastOn = !!(payfast.data?.live || payfast.data?.test);

  // Open PayFast's checkout for an invoice by posting the signed fields there.
  async function payOnline(id: number) {
    try {
      const { url, fields } = await apiGet<{ url: string; fields: Record<string, string> }>(`/documents/${id}/pay-link`);
      const form = document.createElement('form');
      form.method = 'POST'; form.action = url; form.target = '_blank';
      for (const [k, v] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden'; input.name = k; input.value = v; form.appendChild(input);
      }
      document.body.appendChild(form); form.submit(); form.remove();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not start the payment.', 'error');
    }
  }

  // Click-to-chat: WhatsApp opens with the invoice (pay link) or quote (accept
  // link) message written, sent from the founder's own phone.
  const whatsapp = async (id: number) => {
    try {
      const r = await apiGet<{ url: string }>(`/documents/${id}/whatsapp-link`);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not build the WhatsApp link.', 'error');
    }
  };
  const todayStr = new Date().toISOString().slice(0, 10);
  // The signed public link a client can accept the quote on, no account needed.
  const copyQuoteLink = async (id: number) => {
    try {
      const r = await apiGet<{ url: string }>(`/documents/${id}/quote-link`);
      await navigator.clipboard.writeText(r.url);
      notify('Accept link copied. Anyone with it can view and accept this quote.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not build the link.', 'error');
    }
  };

  const setStatus = useMutation({
    mutationFn: (v: { id: number; status: Status }) => apiPatch(`/documents/${v.id}/status`, { status: v.status }),
    onSuccess: invalidate,
    // The server refuses some of these with a reason. With no onError the dropdown just
    // snapped back and the person had no idea why their change did not take.
    onError: (e: Error) => { invalidate(); notify(e.message || 'Could not change the status.', 'error'); },
  });
  /**
   * Void, delete and convert failed in silence. The confirm dialog closed, the row stayed
   * exactly as it was, and nothing said why, so a person could reasonably believe an
   * invoice was voided while it went on being chased. The server already explains every
   * refusal (a viewer's 403, a stale row's 404); it just never reached the screen.
   */
  const del = useMutation({
    mutationFn: (id: number) => apiDelete(`/documents/${id}`),
    onSuccess: invalidate,
    onError: (e: Error) => notify(e.message || 'Could not void or delete that document.', 'error'),
  });
  const convert = useMutation({
    mutationFn: (id: number) => apiPost(`/documents/${id}/convert`),
    onSuccess: () => { invalidate(); setTab('invoice'); },
    onError: (e: Error) => notify(e.message || 'Could not turn the quote into an invoice.', 'error'),
  });
  const email = useMutation({
    mutationFn: (v: { id: number; message?: string }) => apiPost<{ to: string }>(`/documents/${v.id}/email`, { message: v.message }),
    onSuccess: (r) => { invalidate(); notify(`Sent to ${r.to}.`); },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not send.', 'error'),
  });

  return (
    <Page>
      <PageHeader view="billing" title="Billing"
        subtitle="Quotes, invoices and what has been paid."
        actions={(
          <button onClick={() => setEditing('new')}
            className="flex min-h-10 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 sm:min-h-9">
            <Plus size={15} /> New {tab}
          </button>
        )}>
        <div className="flex w-fit gap-1 rounded-lg bg-slate-900 p-1">
          {(['invoice', 'quote'] as DocType[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`min-h-9 rounded-md px-3 text-xs font-medium capitalize ${tab === t ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {t}s
            </button>
          ))}
        </div>
      </PageHeader>
      <PageBody>

        {/* Sandbox is the default and the setup screen advises leaving it on for a trial,
            so an owner can easily forget it. Until then every client gets a pay link to
            PayFast's test checkout, and a test payment there is recorded as real. */}
        {payfast.data?.test && (
          <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            PayFast is in test mode{businessId === 'all' ? ' for at least one business' : ''}. The Pay online
            button on invoices and reminders opens a test checkout, and a test payment there marks the
            invoice paid with no money moved. Switch Sandbox off under Settings, Payments once your test
            payment has worked.
          </p>
        )}

        {isLoading && <Skeleton className="h-56" />}
        {!isLoading && (<>
        <div className="hidden overflow-x-auto rounded-xl border border-slate-800 sm:block">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Number</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Date</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {docs.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-4">
                  <EmptyState
                    title={tab === 'invoice' ? 'No invoices yet' : 'No quotes yet'}
                    body={tab === 'invoice'
                      ? 'Raise your first invoice, or pull one straight from tracked time.'
                      : 'A quote a client accepts becomes an invoice in one click.'}
                    actionLabel={tab === 'invoice' ? 'New invoice' : 'New quote'}
                    onAction={() => setEditing('new')} />
                </td></tr>
              )}
              {docs.map((d) => (
                <tr key={d.id} className="group border-t border-slate-800">
                  <td className="px-3 py-2 font-medium text-slate-200">
                    {d.number}
                    {/* A quote past its valid-until that nobody decided on. The public
                        accept page refuses it too; this is the staff-side echo. */}
                    {d.type === 'quote' && d.status === 'sent' && d.dueDate && d.dueDate < todayStr && (
                      <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">Expired</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{d.clientName}</td>
                  <td className="hidden px-3 py-2 text-slate-400 sm:table-cell">{d.issueDate}</td>
                  <td className="px-3 py-2">
                    {d.status === 'paid' || d.status === 'void' ? (
                      // Paid and void are outcomes, not labels: paid is recorded in the
                      // Payments modal (so a payment row exists) and void via delete.
                      // Making them pickable here created two sources of truth.
                      <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] ${STATUS_COLOR[d.status]}`}>{d.status}</span>
                    ) : (
                      <select value={d.status} onChange={(e) => setStatus.mutate({ id: d.id, status: e.target.value as Status })}
                        className={`rounded-md px-2 py-0.5 text-[11px] ${STATUS_COLOR[d.status]}`}>
                        {statusOptions(d.type, d.status).map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right num text-slate-100">{money(d.total, d.currency)}</td>
                  <td className="px-3 py-2">
                    {/* Seven bare 15px icons, 4px apart, two destructive, was an
                        accessibility failure and a fat-finger trap on a phone. The
                        two everyday actions stay one tap; the rest live in a menu. */}
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setEditing(d.id)} title="Edit"
                        className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-200"><Pencil size={14} /></button>
                      {d.type === 'invoice' && (
                        <button onClick={() => setPaying(d)} title="Payments"
                          className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-800 hover:text-green-300"><DollarSign size={14} /></button>
                      )}
                      <Menu align="right"
                        trigger={<span className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-200"><MoreHorizontal size={15} /></span>}
                        items={[
                          { label: 'Print / PDF', onClick: () => setPrinting(d.id) },
                          { label: 'Email to client', onClick: async () => { const m = await promptDialog('Optional message to include (blank for default):', ''); if (m !== null) email.mutate({ id: d.id, message: m || undefined }); } },
                          ...(d.status !== 'draft' && d.status !== 'void' ? [{ label: 'Send via WhatsApp', onClick: () => whatsapp(d.id) }] : []),
                          ...(d.type === 'invoice' && d.status !== 'paid' && payfastOn
                            ? [{ label: 'Open PayFast checkout', onClick: () => payOnline(d.id) }] : []),
                          ...(d.type === 'quote'
                            ? [{ label: 'Convert to invoice', onClick: () => convert.mutate(d.id) }] : []),
                          ...(d.type === 'quote' && d.status === 'sent'
                            ? [{ label: 'Copy accept link', onClick: () => copyQuoteLink(d.id) }] : []),
                          { label: d.status === 'draft' ? 'Delete' : 'Void', danger: true, onClick: async () => { if (await confirmDialog(d.status === 'draft' ? `Delete ${d.number}?` : `Void ${d.number}? The number is kept, the amount drops out of balances.`, { danger: true })) del.mutate(d.id); } },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* The same list as cards for phones. Six columns of 14px table with 32px
            icon strips was the single worst screen to run a business from; a card
            per document gives the number, the money and finger-sized actions. */}
        <div className="overflow-hidden rounded-xl border border-slate-800 sm:hidden">
          {docs.length === 0 && (
            <div className="px-3 py-6">
              <EmptyState
                title={tab === 'invoice' ? 'No invoices yet' : 'No quotes yet'}
                body={tab === 'invoice'
                  ? 'Raise your first invoice, or pull one straight from tracked time.'
                  : 'A quote a client accepts becomes an invoice in one click.'}
                actionLabel={tab === 'invoice' ? 'New invoice' : 'New quote'}
                onAction={() => setEditing('new')}
              />
            </div>
          )}
          {docs.map((d) => (
            <div key={d.id} className="border-t border-slate-800 px-3 py-3 first:border-t-0">
              <button onClick={() => setEditing(d.id)} className="flex w-full items-start justify-between gap-3 text-left">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="num font-medium text-slate-200">{d.number}</span>
                    {d.type === 'quote' && d.status === 'sent' && d.dueDate && d.dueDate < todayStr && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">Expired</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-slate-400">{d.clientName}</span>
                  <span className="num mt-0.5 block text-[11px] text-slate-500">{d.issueDate}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="num block text-base font-semibold text-slate-100">{money(d.total, d.currency)}</span>
                  <span className={`mt-1 inline-block rounded-md px-2 py-0.5 text-[11px] ${STATUS_COLOR[d.status]}`}>{d.status}</span>
                </span>
              </button>
              <div className="mt-2 flex items-center justify-end gap-1">
                <button onClick={() => setEditing(d.id)} title="Edit" className="tap text-slate-400 hover:bg-slate-800 hover:text-slate-200"><Pencil size={16} /></button>
                {d.type === 'invoice' && (
                  <button onClick={() => setPaying(d)} title="Payments" className="tap text-slate-400 hover:bg-slate-800 hover:text-green-300"><DollarSign size={16} /></button>
                )}
                <Menu align="right"
                  trigger={<span className="tap text-slate-400 hover:bg-slate-800 hover:text-slate-200"><MoreHorizontal size={17} /></span>}
                  items={[
                    { label: 'Print / PDF', onClick: () => setPrinting(d.id) },
                    { label: 'Email to client', onClick: async () => { const m = await promptDialog('Optional message to include (blank for default):', ''); if (m !== null) email.mutate({ id: d.id, message: m || undefined }); } },
                    ...(d.status !== 'draft' && d.status !== 'void' ? [{ label: 'Send via WhatsApp', onClick: () => whatsapp(d.id) }] : []),
                    ...(d.type === 'invoice' && d.status !== 'paid' && payfastOn
                      ? [{ label: 'Open PayFast checkout', onClick: () => payOnline(d.id) }] : []),
                    ...(d.type === 'quote'
                      ? [{ label: 'Convert to invoice', onClick: () => convert.mutate(d.id) }] : []),
                    ...(d.type === 'quote' && d.status === 'sent'
                      ? [{ label: 'Copy accept link', onClick: () => copyQuoteLink(d.id) }] : []),
                    { label: d.status === 'draft' ? 'Delete' : 'Void', danger: true, onClick: async () => { if (await confirmDialog(d.status === 'draft' ? `Delete ${d.number}?` : `Void ${d.number}? The number is kept, the amount drops out of balances.`, { danger: true })) del.mutate(d.id); } },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
        </>)}
      </PageBody>

      {/* Keyed per intent, so opening "New invoice" again while an editor is mounted starts
          a fresh one. Without it a remembered draft id would survive, and the next save
          would overwrite that earlier draft with an unrelated document. */}
      {editing && <Editor key={`${String(editing)}:${tab}`} id={editing} type={tab} businessId={newBusinessId} initialFolderId={editing === 'new' ? initialFolder : null} onClose={() => { setEditing(null); setInitialFolder(null); invalidate(); }} onSaved={() => { setEditing(null); setInitialFolder(null); invalidate(); }} onChanged={invalidate} />}
      {printing && <PrintView id={printing} onClose={() => setPrinting(null)} />}
      {paying && <PaymentsModal doc={paying} onClose={() => { setPaying(null); invalidate(); }} />}
    </Page>
  );
}

function Editor({ id, type, businessId, initialFolderId, onClose, onSaved, onChanged }: { id: number | 'new'; type: DocType; businessId?: number; initialFolderId?: number | null; onClose: () => void; onSaved: () => void; onChanged: () => void }) {
  const isNew = id === 'new';
  /**
   * The document this editor has ALREADY created, when a save went through but the send
   * after it did not.
   *
   * "Save & send" on a new document is two requests: create it, then email it. When the
   * email failed, the new id was thrown away and the editor stayed in "new" mode, so every
   * retry created another invoice with the next number. Verified live: three clicks made
   * INV-0001, INV-0002 and INV-0003 for one intended invoice. Deleting the strays leaves
   * gaps in a sequence SARS expects to be continuous, and hours pulled from tracked time
   * stay stamped against the first stray while the invoice actually sent carries none.
   *
   * Once this is set, every save updates this document instead of creating one.
   *
   * KNOWN GAP, recorded rather than claimed fixed: if the create request commits on the
   * server but its response never reaches the browser (a proxy timeout mid-request), the
   * id is never learned and a retry still duplicates. Closing that needs an idempotency
   * key on POST /documents.
   *
   * Named savedDoc, not saved: the save mutation already has a local called saved, and
   * reading this before that local's declaration would throw at runtime.
   */
  const [savedDoc, setSavedDoc] = useState<{
    id: number; number: string; currency: string; status: string;
  } | null>(null);
  const existing = useQuery({
    queryKey: ['document', id], enabled: !isNew,
    queryFn: () => apiGet<FullDoc>(`/documents/${id}`),
  });

  const [folderId, setFolderId] = useState<number | null>(null);

  // Handed a client by the action row or the palette: point the document at them
  // and pull their billing details, exactly as picking them by hand would.
  const foldersQ = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  useEffect(() => {
    if (id !== 'new' || !initialFolderId || folderId !== null) return;
    const f = foldersQ.data?.folders.find((x) => x.id === initialFolderId);
    if (!f) return;
    setFolderId(f.id);
    setClientName(f.legalName?.trim() || f.name);
    setClientEmail(f.billingEmail ?? '');
    setClientAddress(f.billingAddress ?? '');
    setClientVat(f.billingVatNumber ?? '');
    setClientCurrency(f.currency ?? null);
    if (type === 'invoice' && f.paymentTermsDays != null) {
      const due = new Date(`${todayStr()}T00:00:00`);
      due.setDate(due.getDate() + f.paymentTermsDays);
      setDueDate(iso(due));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersQ.data, initialFolderId, id]);
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientAddress, setClientAddress] = useState('');
  const [clientVat, setClientVat] = useState('');
  // What this client is billed in, when it is not what the business bills in.
  const [clientCurrency, setClientCurrency] = useState<string | null>(null);
  const [issueDate, setIssueDate] = useState(todayStr());
  const [dueDate, setDueDate] = useState('');
  const [taxRate, setTaxRate] = useState(15);
  const [discountType, setDiscountType] = useState<DiscountType>('none');
  const [discountValue, setDiscountValue] = useState(0);
  // What the client pays up front. Stated on the document and offered as its own
  // button on the pay link, so "half to start" is something the client can act on
  // rather than a sentence in the notes.
  const [depositType, setDepositType] = useState<DepositType>('none');
  const [depositValue, setDepositValue] = useState(0);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([{ description: '', quantity: 1, unitPrice: 0 }]);
  const offeringsQ = useQuery({
    queryKey: ['offerings', businessId],
    queryFn: () => apiGet<{ offerings: { id: number; name: string; description: string | null; price: string; recurring: boolean; active: boolean }[] }>(
      businessId ? `/offerings?businessId=${businessId}` : '/offerings'),
  });
  const offeringList = (offeringsQ.data?.offerings ?? []).filter((o) => o.active);
  const [error, setError] = useState<string | null>(null);
  /**
   * Run-once guard for the two blocks below, and it was initialised BACKWARDS.
   *
   * It read useState(isNew), so on a new document it began true and the block that
   * applies the business's tax rate and payment term was skipped on the first render
   * and never ran again. Every new invoice therefore opened at the hardcoded 15% tax
   * and a blank due date, whatever the business had been set to. False is right for
   * both: a new document then takes its defaults, an existing one hydrates.
   */
  const [ready, setReady] = useState(false);

  // "Pull from tracked time" state
  const [showTime, setShowTime] = useState(false);
  const [timeFolder, setTimeFolder] = useState<number | ''>('');
  const [timeFrom, setTimeFrom] = useState(() => todayStr().slice(0, 8) + '01');
  const [timeTo, setTimeTo] = useState(todayStr());
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: TreeFolder[] }>('/folders') });
  const clients = (folders.data?.folders ?? []).filter((f) => f.parentId === null);

  // Remembered when lines were pulled from tracked time, and sent with the save
  // so the server can stamp those entries as billed by this invoice.
  const [pulledTime, setPulledTime] = useState<{ folderId: number; from: string; to: string } | null>(null);
  const pull = useMutation({
    mutationFn: () => apiGet<{ clientName: string; lines: Line[]; totalHours: number }>(
      `/documents/from-time?folderId=${timeFolder}&from=${timeFrom}&to=${timeTo}`),
    onSuccess: (r) => {
      if (r.lines.length === 0) { setError(`No tracked time for that client between ${timeFrom} and ${timeTo}.`); return; }
      setError(null);
      if (typeof timeFolder === 'number') setPulledTime({ folderId: timeFolder, from: timeFrom, to: timeTo });
      if (!clientName.trim()) setClientName(r.clientName);
      // Merge onto any real lines already entered.
      setLines((prev) => {
        const kept = prev.filter((l) => l.description.trim());
        return [...kept, ...r.lines];
      });
      setShowTime(false);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not pull time.'),
  });

  // A new document starts from ITS business's invoicing defaults (tax rate + terms),
  // so the common case needs no adjusting. Falls back to nothing when no business.
  const bizDefaults = useQuery({
    queryKey: ['businesses'], enabled: isNew,
    queryFn: () => apiGet<{ businesses: { id: number; defaultTaxRate: string | null; defaultDueDays: number; currency: string | null }[] }>('/businesses'),
  });
  /**
   * Which business's defaults this document takes.
   *
   * With "All businesses" selected the editor gets no business, and it applied no tax rate
   * and no due date, so every invoice opened at the hardcoded 15%. That matters most for a
   * workspace with ONE business, which is the common case, because "All businesses" is
   * what any fresh browser opens on: a new phone, a private window, the first login after
   * signup. A business set to 0% because it is not VAT registered still got 15% put in
   * front of it.
   *
   * With exactly one business there is nothing ambiguous about which one is meant, so it is
   * used. With several and none chosen it stays undecided, which is a separate question.
   *
   * This deliberately does NOT switch the whole workspace into that business. Doing that
   * would re-filter every list by business, and contacts created while "All businesses" was
   * selected are stored with no business at all, so they would disappear from Contacts.
   */
  const onlyBusiness = bizDefaults.data?.businesses.length === 1 ? bizDefaults.data.businesses[0]!.id : undefined;
  const defaultsBusinessId = businessId ?? onlyBusiness;
  // Waits for the business list whenever no business was passed in. The old condition ran
  // immediately in that case, found nothing, and set `ready`, so the defaults could never
  // be applied once the list arrived a moment later.
  if (isNew && bizDefaults.data && !ready) {
    const biz = bizDefaults.data.businesses.find((b) => b.id === defaultsBusinessId);
    if (biz) {
      if (biz.defaultTaxRate != null) setTaxRate(Number(biz.defaultTaxRate));
      // `!= null` and not `> 0`: a business billing on receipt is set to zero days,
      // and `> 0` reads that as "unset" and leaves the date blank instead.
      // Only when nothing has set one already, so a client picked before this query
      // resolved keeps their own term rather than being overwritten by the default.
      if (type === 'invoice' && biz.defaultDueDays != null && !dueDate) {
        const due = new Date(`${issueDate}T00:00:00`);
        due.setDate(due.getDate() + biz.defaultDueDays);
        setDueDate(iso(due));
      }
    }
    setReady(true);
  }

  // Hydrate from the existing document once.
  if (!isNew && existing.data && !ready) {
    const d = existing.data.document;
    setFolderId(d.folderId ?? null);
    setClientName(d.clientName); setClientEmail(d.clientEmail ?? ''); setClientAddress(d.clientAddress ?? '');
    setClientVat(d.clientVatNumber ?? '');
    setIssueDate(d.issueDate); setDueDate(d.dueDate ?? ''); setTaxRate(Number(d.taxRate));
    setDiscountType(d.discountType ?? 'none'); setDiscountValue(Number(d.discountValue ?? 0));
    setDepositType(d.depositType ?? 'none'); setDepositValue(Number(d.depositValue ?? 0));
    setNotes(d.notes ?? '');
    setLines(existing.data.lines.map((l) => ({
      description: l.description, detail: l.detail ?? null,
      quantity: Number(l.quantity), unitPrice: Number(l.unitPrice),
      offeringId: l.offeringId ?? null, recurringMonths: l.recurringMonths ?? null,
    })));
    setReady(true);
  }

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const discount = discountType === 'percent' ? subtotal * (Math.min(discountValue, 100) / 100)
    : discountType === 'amount' ? Math.min(discountValue, subtotal) : 0;
  const tax = (subtotal - discount) * (taxRate / 100);
  // Off the total, tax included, exactly as the server computes it, so the editor
  // and the document can never disagree about what is due up front.
  const grand = subtotal - discount + tax;
  const deposit = depositType === 'percent' ? grand * (Math.min(depositValue, 100) / 100)
    : depositType === 'amount' ? Math.min(depositValue, grand) : 0;
  /**
   * What to show the amounts in.
   *
   * An existing document carries its own, copied at the moment it was raised. A new
   * one was hardcoded to ZAR, which is simply wrong for a business billing in
   * anything else: the screen said R and the server saved GBP. Resolved the same way
   * the server resolves it, so the two agree before anything is typed.
   */
  const bizCurrency = bizDefaults.data?.businesses.find((b) => b.id === defaultsBusinessId)?.currency ?? null;
  // A saved draft's currency is fixed on the server and PUT never recomputes it, so once
  // one exists it wins; otherwise picking a client billed elsewhere would show their
  // currency on screen while the stored document kept the original.
  const currency = existing.data?.document.currency ?? savedDoc?.currency
    ?? clientCurrency ?? bizCurrency ?? 'ZAR';

  const save = useMutation({
    mutationFn: async (opts?: { send?: boolean }) => {
      // Update what this editor already made, rather than making another.
      const targetId = savedDoc?.id ?? (isNew ? null : id);
      const creating = targetId === null;
      const body = {
        type, folderId, clientName: clientName.trim(), clientEmail: clientEmail.trim() || null,
        clientAddress: clientAddress.trim() || null, clientVatNumber: clientVat.trim() || null,
        issueDate, dueDate: dueDate || null,
        taxRate, discountType, discountValue: Number(discountValue) || 0,
        depositType, depositValue: Number(depositValue) || 0, notes: notes.trim() || null,
        // Only on create. PUT does not take a business, and restamping tracked time onto a
        // retry would link the same hours twice.
        ...(creating && businessId ? { businessId } : {}),
        ...(creating && type === 'invoice' && pulledTime ? { fromTime: pulledTime } : {}),
        lines: lines.filter((l) => l.description.trim()).map((l) => ({
          description: l.description.trim(),
          detail: l.detail?.trim() || null,
          quantity: Number(l.quantity) || 0,
          unitPrice: Number(l.unitPrice) || 0,
          offeringId: l.offeringId ?? null,
          recurringMonths: l.offeringId ? (l.recurringMonths ?? null) : null,
        })),
      };
      type Doc = { id: number; number: string; currency: string; status: string; dueDate: string | null };
      let doc: Doc;
      if (creating) {
        doc = (await apiPost<{ document: Doc }>('/documents', body)).document;
        // Recorded BEFORE the send, which is the whole point: if the send fails, a retry
        // now finds this document instead of creating a second one.
        setSavedDoc({ id: doc.id, number: doc.number, currency: doc.currency, status: doc.status });
        // Show the due date the server actually stored. Leaving the field blank while the
        // document carries a server-set date would mean the next PUT writes null over it.
        setDueDate(doc.dueDate ?? '');
        // Put it in the list now, so it is visible however this editor is closed.
        onChanged();
      } else {
        doc = (await apiPut<{ document: Doc }>(`/documents/${targetId}`, body)).document;
      }

      if (opts?.send) {
        /**
         * A retry must not email the client twice. An email request can time out at a proxy
         * while the server carries on and sends, which marks the document sent. So when this
         * is a retry, check first and ask.
         */
        if (savedDoc) {
          const fresh = await apiGet<{ document: { status: string } }>(`/documents/${doc.id}`);
          if (fresh.document.status === 'sent') {
            const again = await confirmDialog(
              `${doc.number} is already marked as sent, so the last attempt may have reached the client. Send it again?`,
              { confirmLabel: 'Send again' });
            if (!again) return { sentTo: null, stopped: true };
          }
        }
        try {
          const r = await apiPost<{ to: string }>(`/documents/${doc.id}/email`, {});
          return { sentTo: r.to };
        } catch (e) {
          // Say the document EXISTS. The old message only said the email failed, so people
          // reasonably assumed nothing was saved and created it again.
          const why = e instanceof Error ? e.message : 'the email could not be sent.';
          throw new Error(`Saved as ${doc.number}, but not sent: ${why} Fix the mail settings, then press Save & send again. It will send ${doc.number}, not make a new one.`);
        }
      }
      return { sentTo: null };
    },
    onSuccess: (r) => {
      if ('stopped' in r && r.stopped) return;
      if (r.sentTo) notify(`Saved and sent to ${r.sentTo}.`);
      onSaved();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  const field = fieldClass;

  /**
   * Has anything been typed that would be lost?
   *
   * Ruben lost a whole invoice to one click outside the dialog. A confirm on every
   * close would be nagging, and no confirm at all costs somebody ten minutes of
   * work, so it asks only when there is something to lose.
   */
  const hasContent = Boolean(
    clientName.trim() || clientEmail.trim() || clientAddress.trim() || clientVat.trim()
    || notes.trim() || folderId
    || lines.some((l) => l.description.trim() || Number(l.quantity) !== 1 || Number(l.unitPrice) !== 0),
  );
  const confirmClose = async () => {
    if (!hasContent) return true;
    // Once a draft has been saved, "everything will be lost" is false, and believing it is
    // exactly what made people type the invoice in again. Say what is actually true.
    if (savedDoc) {
      return confirmDialog(`${savedDoc.number} is saved as a draft. Any changes since then will not be kept.`,
        { confirmLabel: 'Close' });
    }
    return confirmDialog('Close without saving? Anything you have entered on this document will be lost.',
      { confirmLabel: 'Discard', danger: true });
  };

  return (
    <Modal onClose={onClose} size="lg" confirmClose={confirmClose} labelledBy="doc-editor-title">
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="doc-editor-title" className="font-display text-lg font-semibold text-slate-100 capitalize">{isNew && !savedDoc ? `New ${type}` : `Edit ${type}${savedDoc ? ` ${savedDoc.number}` : ''}`}</h2>
          <button onClick={async () => { if (await confirmClose()) onClose(); }} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ClientPicker businessId={businessId} value={{
            folderId, name: clientName, email: clientEmail, address: clientAddress, vatNumber: clientVat,
          }} onChange={(v) => {
            setFolderId(v.folderId); setClientName(v.name);
            // Only overwrite details that came with the client, so a name typed by
            // hand on a one-off is not wiped by choosing nothing.
            if (v.folderId) {
              setClientEmail(v.email); setClientAddress(v.address); setClientVat(v.vatNumber);
              setClientCurrency(v.currency ?? null);
              // Their own payment terms, if they have any. `!= null` rather than a
              // truthy check: zero days is a real arrangement meaning on receipt,
              // and treating it as unset would quietly give them the default instead.
              if (type === 'invoice' && v.paymentTermsDays != null) {
                const due = new Date(`${issueDate}T00:00:00`);
                due.setDate(due.getDate() + v.paymentTermsDays);
                setDueDate(iso(due));
              }
            }
          }} />
          <input className={field} placeholder="Client email (optional)" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} />
        </div>
        <textarea className={field + ' mt-3'} placeholder="Client address (optional)" value={clientAddress} onChange={(e) => setClientAddress(e.target.value)} />
        <input className={field + ' mt-3'} placeholder="Client VAT number (optional, for tax invoices)" value={clientVat} onChange={(e) => setClientVat(e.target.value)} />

        {/* Klippy never converts between currencies, anywhere. So billing a client in
            something other than the business currency is safe only as long as the
            person typing knows the amounts have to be entered in it: an offering
            priced at 5000 rand dropped into a pounds invoice does not become 5000
            rand, it becomes 5000 pounds. Worth a line on screen rather than a
            surprise at the bottom of a PDF. */}
        {clientCurrency && bizCurrency && clientCurrency !== bizCurrency && (
          <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-2 text-[11px] text-amber-200">
            This client is billed in {clientCurrency}, and {bizCurrency} is what the
            business bills in. Klippy does not convert, so enter every amount in
            {' '}{clientCurrency}, including anything you add from your offerings.
          </p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><label className="mb-1 block text-[11px] text-slate-500">Issue date</label><input type="date" className={field} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></div>
          <div><label className="mb-1 block text-[11px] text-slate-500">{type === 'quote' ? 'Valid until' : 'Due date'}</label><input type="date" className={field} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
          <div><label className="mb-1 block text-[11px] text-slate-500">Tax %</label><input type="number" className={field} value={taxRate} onChange={(e) => setTaxRate(Number(e.target.value))} /></div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">Discount</label>
            <select className={field} value={discountType} onChange={(e) => setDiscountType(e.target.value as DiscountType)}>
              <option value="none">No discount</option>
              <option value="percent">Percent (%)</option>
              <option value="amount">Fixed amount</option>
            </select>
          </div>
          {discountType !== 'none' && (
            <div>
              <label className="mb-1 block text-[11px] text-slate-500">{discountType === 'percent' ? 'Percent off' : 'Amount off'}</label>
              <input type="number" min={0} className={field} value={discountValue} onChange={(e) => setDiscountValue(Number(e.target.value))} />
            </div>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-slate-500">Deposit</label>
            <select className={field} value={depositType} onChange={(e) => setDepositType(e.target.value as DepositType)}>
              <option value="none">No deposit</option>
              <option value="percent">Percent of total (%)</option>
              <option value="amount">Fixed amount</option>
            </select>
          </div>
          {depositType !== 'none' && (
            <div>
              <label className="mb-1 block text-[11px] text-slate-500">{depositType === 'percent' ? 'Percent up front' : 'Amount up front'}</label>
              <input type="number" min={0} className={field} value={depositValue} onChange={(e) => setDepositValue(Number(e.target.value))} />
            </div>
          )}
        </div>
        {depositType !== 'none' && (
          <p className="mt-1.5 text-[11px] text-slate-500">
            Printed under the total, and the pay link offers it as its own button. The invoice keeps its
            full amount: a deposit is a payment against it, so what is still owed stays right.
          </p>
        )}

        {/* Pull from tracked time */}
        {type === 'invoice' && (
          <div className="mt-4">
            {savedDoc ? (
              // Updating a saved draft cannot link tracked hours to it, so pulling time now
              // would leave those hours unbilled and open to being billed twice.
              <p className="text-[11px] text-slate-500">
                Tracked time can only be pulled in when a document is first created.
              </p>
            ) : !showTime ? (
              <button onClick={() => setShowTime(true)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                <Clock size={13} /> Pull from tracked time
              </button>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <div className="mb-2 text-xs font-medium text-slate-400">Bill tracked hours for a client</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                  <select className={field + ' sm:col-span-2'} value={timeFolder}
                    onChange={(e) => setTimeFolder(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">Choose client...</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input type="date" className={field} value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
                  <input type="date" className={field} value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
                </div>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => timeFolder ? pull.mutate() : setError('Pick a client first.')} disabled={pull.isPending}
                    className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
                    {pull.isPending ? 'Loading...' : 'Add lines from time'}
                  </button>
                  <button onClick={() => setShowTime(false)} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Adds one line per board with logged time, using the client's hourly rate. Set a rate on the client (sidebar ⋯ menu) first.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Line items */}
        <div className="mt-4">
          <div className="mb-1 grid grid-cols-12 gap-2 text-[11px] text-slate-500">
            <span className="col-span-6">Description</span><span className="col-span-2 text-right">Qty</span>
            <span className="col-span-3 text-right">Unit price</span><span className="col-span-1"></span>
          </div>
          {lines.map((l, i) => {
            const set = (patch: Partial<Line>) =>
              setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="mb-2">
                <div className="grid grid-cols-12 gap-2">
                  <input className={field + ' col-span-6'} placeholder="Item or service" value={l.description}
                    onChange={(e) => set({ description: e.target.value })} />
                  <input type="number" className={field + ' col-span-2 text-right'} value={l.quantity}
                    onChange={(e) => set({ quantity: Number(e.target.value) })} />
                  <input type="number" className={field + ' col-span-3 text-right'} value={l.unitPrice}
                    onChange={(e) => set({ unitPrice: Number(e.target.value) })} />
                  <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="col-span-1 grid place-items-center text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
                </div>

                {/* The longer wording. Hidden behind a link until it is wanted, so
                    a three-line invoice stays a three-line invoice, but one click away
                    because "what was this for?" is the most common reply to a bill. */}
                {l.detail != null ? (
                  <textarea
                    className={field + ' mt-1 min-h-[52px] w-full resize-y text-xs'}
                    autoFocus={l.detail === ''}
                    placeholder="What this covers, in the client's words. Printed under the line on the PDF."
                    value={l.detail}
                    onChange={(e) => set({ detail: e.target.value })} />
                ) : (
                  <button type="button" onClick={() => set({ detail: '' })}
                    className="mt-1 text-[11px] text-slate-500 hover:text-slate-300">
                    + Add a description
                  </button>
                )}

                {/* Pick from the catalogue instead of typing, and the line knows what
                    it is selling. That is what lets a recurring thing on an invoice
                    actually start a subscription when the invoice is paid. */}
                <div className="mt-1 grid grid-cols-12 gap-2">
                  <select className={field + ' col-span-6 text-xs'} value={l.offeringId ?? ''}
                    onChange={(e) => {
                      const id = e.target.value ? Number(e.target.value) : null;
                      const o = offeringList.find((x) => x.id === id);
                      if (!o) { set({ offeringId: null, recurringMonths: null }); return; }
                      set({
                        offeringId: o.id,
                        description: l.description.trim() || o.name,
                        // The offering's own words, unless this line already has some.
                        // Written once on the offering, reused on every document that
                        // sells it, and still editable here for a one-off caveat.
                        detail: l.detail || o.description || null,
                        unitPrice: Number(o.price) || l.unitPrice,
                        // Recurring offerings default to monthly, which is the common
                        // case; anything sold by the year is changed on the next control.
                        recurringMonths: o.recurring ? (l.recurringMonths ?? 1) : null,
                      });
                    }}>
                    <option value="">Not from the catalogue</option>
                    {offeringList.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}{o.recurring ? ' (recurring)' : ''}</option>
                    ))}
                  </select>

                  <select className={field + ' col-span-5 text-xs'}
                    value={l.recurringMonths ?? ''}
                    disabled={!l.offeringId}
                    onChange={(e) => set({ recurringMonths: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">One-off, does not repeat</option>
                    <option value={1}>Bills every month</option>
                    <option value={3}>Bills every quarter</option>
                    <option value={6}>Bills every 6 months</option>
                    <option value={12}>Bills every year</option>
                  </select>
                </div>

                {l.recurringMonths ? (
                  <p className="mt-1 text-[11px] text-violet-300">
                    Paying this invoice starts a subscription. The next bill goes out in{' '}
                    {l.recurringMonths === 1 ? 'a month' : `${l.recurringMonths} months`}, not today.
                  </p>
                ) : null}
              </div>
            );
          })}
          <button onClick={() => setLines([...lines, { description: '', quantity: 1, unitPrice: 0 }])}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            <Plus size={13} /> Add line
          </button>
        </div>

        <div className="mt-4 flex justify-end">
          <div className="w-56 space-y-1 text-sm">
            <div className="flex justify-between text-slate-400"><span>Subtotal</span><span className="num">{money(subtotal, currency)}</span></div>
            {discount > 0 && <div className="flex justify-between text-slate-400"><span>Discount</span><span className="num">-{money(discount, currency)}</span></div>}
            <div className="flex justify-between text-slate-400"><span>Tax ({taxRate}%)</span><span className="num">{money(tax, currency)}</span></div>
            <div className="flex justify-between border-t border-slate-800 pt-1 font-semibold text-slate-100"><span>Total</span><span className="num">{money(subtotal - discount + tax, currency)}</span></div>
            {deposit > 0 && (
              <>
                <div className="flex justify-between pt-1 text-[var(--accent)]">
                  <span>Deposit{depositType === 'percent' ? ` (${depositValue}%)` : ''}</span>
                  <span className="num">{money(deposit, currency)}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Balance afterwards</span>
                  <span className="num">{money(subtotal - discount + tax - deposit, currency)}</span>
                </div>
              </>
            )}
          </div>
        </div>

        <textarea className={field + ' mt-3'} placeholder="Notes / payment terms (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {error && <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <div className="mt-4 flex gap-2">
          <button onClick={() => clientName.trim() ? save.mutate(undefined) : setError('Client name is required.')} disabled={save.isPending}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
            {save.isPending ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={() => clientName.trim() ? save.mutate({ send: true }) : setError('Client name is required.')}
            disabled={save.isPending || !clientEmail.trim()}
            title={clientEmail.trim() ? 'Save, then email it to the client with the PDF attached' : 'Add a client email first'}
            className="rounded-lg border border-violet-600 px-4 py-2 text-sm font-medium text-violet-300 hover:bg-violet-600/10 disabled:opacity-40">
            Save &amp; send
          </button>
          <button onClick={async () => { if (await confirmClose()) onClose(); }}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

/** A credit note raised against this invoice, reducing what is owed. */
