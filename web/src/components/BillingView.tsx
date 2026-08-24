import { useEffect, useState } from 'react';
import { confirmDialog, promptDialog, notify } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X, Pencil, Clock, DollarSign, MoreHorizontal, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../lib/api';
import { ClientPicker } from './ClientPicker';
import type { Folder } from '../lib/types';
import { useUrlAction, takeUrlParam } from '../lib/urlAction';
import { EmptyState, Skeleton } from './ui';
import { Modal } from './Modal';
import { Menu } from './Menu';
import { PrintView } from './InvoicePrintView';
import { PaymentsModal } from './PaymentsModal';
import type { BusinessSelection } from './BusinessSwitcher';
import { fieldClass } from './ui';
import {
  money, STATUS_COLOR, type TreeFolder, type DocType, type Status, type DocSummary,
  type Line, type DiscountType, type FullDoc,
} from './billingShared';

const todayStr = () => new Date().toISOString().slice(0, 10);

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

  // Only offer "Pay online" when PayFast is actually switched on.
  const payfast = useQuery({ queryKey: ['payfast'], queryFn: () => apiGet<{ configured: { enabled: boolean } }>('/account/payfast') });
  const payfastOn = payfast.data?.configured.enabled ?? false;

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
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/documents/${id}`), onSuccess: invalidate });
  const convert = useMutation({
    mutationFn: (id: number) => apiPost(`/documents/${id}/convert`),
    onSuccess: () => { invalidate(); setTab('invoice'); },
  });
  const email = useMutation({
    mutationFn: (v: { id: number; message?: string }) => apiPost<{ to: string }>(`/documents/${v.id}/email`, { message: v.message }),
    onSuccess: (r) => { invalidate(); notify(`Sent to ${r.to}.`); },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not send.', 'error'),
  });

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-slate-900 p-1">
            {(['invoice', 'quote'] as DocType[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`min-h-10 rounded-md px-3 text-xs font-medium capitalize sm:min-h-9 ${tab === t ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
                {t}s
              </button>
            ))}
          </div>
          <button onClick={() => setEditing('new')}
            className="ml-auto flex min-h-10 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 sm:min-h-9">
            <Plus size={15} /> New {tab}
          </button>
        </div>

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
                        {(['draft', 'sent', 'accepted'] as Status[]).map((s) => <option key={s} value={s}>{s}</option>)}
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
      </div>

      {editing && <Editor id={editing} type={tab} businessId={newBusinessId} initialFolderId={editing === 'new' ? initialFolder : null} onClose={() => { setEditing(null); setInitialFolder(null); }} onSaved={() => { setEditing(null); setInitialFolder(null); invalidate(); }} />}
      {printing && <PrintView id={printing} onClose={() => setPrinting(null)} />}
      {paying && <PaymentsModal doc={paying} onClose={() => { setPaying(null); invalidate(); }} />}
    </div>
  );
}

function Editor({ id, type, businessId, initialFolderId, onClose, onSaved }: { id: number | 'new'; type: DocType; businessId?: number; initialFolderId?: number | null; onClose: () => void; onSaved: () => void }) {
  const isNew = id === 'new';
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
    setClientName(f.name);
    setClientEmail(f.billingEmail ?? '');
    setClientAddress(f.billingAddress ?? '');
    setClientVat(f.billingVatNumber ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersQ.data, initialFolderId, id]);
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientAddress, setClientAddress] = useState('');
  const [clientVat, setClientVat] = useState('');
  const [issueDate, setIssueDate] = useState(todayStr());
  const [dueDate, setDueDate] = useState('');
  const [taxRate, setTaxRate] = useState(15);
  const [discountType, setDiscountType] = useState<DiscountType>('none');
  const [discountValue, setDiscountValue] = useState(0);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([{ description: '', quantity: 1, unitPrice: 0 }]);
  const offeringsQ = useQuery({
    queryKey: ['offerings', businessId],
    queryFn: () => apiGet<{ offerings: { id: number; name: string; description: string | null; price: string; recurring: boolean; active: boolean }[] }>(
      businessId ? `/offerings?businessId=${businessId}` : '/offerings'),
  });
  const offeringList = (offeringsQ.data?.offerings ?? []).filter((o) => o.active);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(isNew);

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
    queryFn: () => apiGet<{ businesses: { id: number; defaultTaxRate: string | null; defaultDueDays: number }[] }>('/businesses'),
  });
  if (isNew && (bizDefaults.data || !businessId) && !ready) {
    const biz = bizDefaults.data?.businesses.find((b) => b.id === businessId);
    if (biz) {
      if (biz.defaultTaxRate != null) setTaxRate(Number(biz.defaultTaxRate));
      if (type === 'invoice' && biz.defaultDueDays > 0) {
        const due = new Date(`${issueDate}T00:00:00`);
        due.setDate(due.getDate() + biz.defaultDueDays);
        setDueDate(due.toISOString().slice(0, 10));
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
  const currency = existing.data?.document.currency ?? 'ZAR';

  const save = useMutation({
    mutationFn: async (opts?: { send?: boolean }) => {
      const body = {
        type, folderId, clientName: clientName.trim(), clientEmail: clientEmail.trim() || null,
        clientAddress: clientAddress.trim() || null, clientVatNumber: clientVat.trim() || null,
        issueDate, dueDate: dueDate || null,
        taxRate, discountType, discountValue: Number(discountValue) || 0, notes: notes.trim() || null,
        ...(isNew && businessId ? { businessId } : {}),
        ...(isNew && type === 'invoice' && pulledTime ? { fromTime: pulledTime } : {}),
        lines: lines.filter((l) => l.description.trim()).map((l) => ({
          description: l.description.trim(),
          detail: l.detail?.trim() || null,
          quantity: Number(l.quantity) || 0,
          unitPrice: Number(l.unitPrice) || 0,
          offeringId: l.offeringId ?? null,
          recurringMonths: l.offeringId ? (l.recurringMonths ?? null) : null,
        })),
      };
      const saved = isNew
        ? await apiPost<{ document: { id: number } }>('/documents', body)
        : await apiPut<{ document: { id: number } }>(`/documents/${id}`, body);
      // Sending used to live only behind a 14px mail icon on the row, a full
      // screen away from where the document was written. Saving and sending is
      // one intent, so it is one button.
      if (opts?.send) {
        const r = await apiPost<{ to: string }>(`/documents/${saved.document.id}/email`, {});
        return { sentTo: r.to };
      }
      return { sentTo: null };
    },
    onSuccess: (r) => { if (r.sentTo) notify(`Saved and sent to ${r.sentTo}.`); onSaved(); },
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
    return confirmDialog('Close without saving? Anything you have entered on this document will be lost.',
      { confirmLabel: 'Discard', danger: true });
  };

  return (
    <Modal onClose={onClose} size="lg" confirmClose={confirmClose} labelledBy="doc-editor-title">
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="doc-editor-title" className="font-display text-lg font-semibold text-slate-100 capitalize">{isNew ? `New ${type}` : `Edit ${type}`}</h2>
          <button onClick={async () => { if (await confirmClose()) onClose(); }} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ClientPicker businessId={businessId} value={{
            folderId, name: clientName, email: clientEmail, address: clientAddress, vatNumber: clientVat,
          }} onChange={(v) => {
            setFolderId(v.folderId); setClientName(v.name);
            // Only overwrite details that came with the client, so a name typed by
            // hand on a one-off is not wiped by choosing nothing.
            if (v.folderId) { setClientEmail(v.email); setClientAddress(v.address); setClientVat(v.vatNumber); }
          }} />
          <input className={field} placeholder="Client email (optional)" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} />
        </div>
        <textarea className={field + ' mt-3'} placeholder="Client address (optional)" value={clientAddress} onChange={(e) => setClientAddress(e.target.value)} />
        <input className={field + ' mt-3'} placeholder="Client VAT number (optional, for tax invoices)" value={clientVat} onChange={(e) => setClientVat(e.target.value)} />
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

        {/* Pull from tracked time */}
        {type === 'invoice' && (
          <div className="mt-4">
            {!showTime ? (
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
