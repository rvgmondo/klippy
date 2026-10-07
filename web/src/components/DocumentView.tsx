import { useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Pencil, Printer, AlertTriangle, CheckCircle2, Clock, Copy } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { money } from '../lib/money';
import { navigateTo } from '../lib/urlAction';
import { Modal } from './Modal';
import { notify } from './ConfirmDialog';
import { PaymentsModal } from './PaymentsModal';
import { ReminderPanel } from './ReminderPanel';
import { PrintView } from './InvoicePrintView';
import { DocActionSheet, useMoneyRefresh, type DocAction } from './DocActionSheet';
import { Skeleton, btnPrimary, btnSecondary } from './ui';
import type { FullDoc, DocSummary } from './billingShared';

/**
 * One invoice, quote or credit note, as a person thinks of it.
 *
 * Opening a document used to drop you straight into its edit form, so looking at
 * an invoice to see whether it was paid meant one stray keystroke from changing
 * it. This shows who it is for, what is still owed, what has happened to it, and
 * the one thing it needs next, as a button that does it. Editing is a choice you
 * make from here, not where you land.
 */

interface Extra {
  businessId: number | null; lastReminderOn: string | null;
  decision: 'accepted' | 'declined' | null; decisionAt: string | null; decisionBy: string | null;
}
interface Pay { id: number; amount: string; paidOn: string; method: string | null; note: string | null }
interface Credit { id: number; number: string; total: string; status: string; issueDate?: string }
interface Payments { payments: Pay[]; credits: Credit[]; paid: number; credited: number; outstanding: number; total: number }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const say = (d: string | null | undefined) => (d ? `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}` : '');
const today = () => new Date().toISOString().slice(0, 10);
const daysLate = (due: string) => Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);

export function DocumentView({ id, onClose, onEdit, onOpen }: {
  id: number;
  onClose: () => void;
  onEdit: (id: number, type: string) => void;
  /** Move the view to another document, such as the invoice a quote just became. */
  onOpen: (id: number) => void;
}) {
  const refresh = useMoneyRefresh();
  const { data, isLoading, error } = useQuery({
    queryKey: ['document', id],
    queryFn: () => apiGet<FullDoc & { document: Extra }>(`/documents/${id}`),
  });
  const isInvoice = data?.document.type === 'invoice';
  const pays = useQuery({
    queryKey: ['payments', id],
    queryFn: () => apiGet<Payments>(`/documents/${id}/payments`),
    enabled: isInvoice,
  });
  const [sheet, setSheet] = useState<DocAction | null>(null);
  const [paying, setPaying] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [busy, setBusy] = useState(false);

  if (isLoading || !data) {
    return (
      <Modal onClose={onClose} variant="drawer">
        <div className="space-y-3 p-5">
          {error ? <p className="text-sm text-red-400">This document could not be opened. {error instanceof Error ? error.message : ''}</p>
            : <><Skeleton className="h-8 w-40" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></>}
        </div>
      </Modal>
    );
  }

  const d = data.document;
  const docType: string = d.type;
  const kind = docType === 'quote' ? 'Quote' : docType === 'credit_note' ? 'Credit note' : 'Invoice';
  const total = Number(d.total);
  const owed = isInvoice ? (pays.data?.outstanding ?? total) : 0;
  const late = isInvoice && d.status === 'sent' && !!d.dueDate && d.dueDate < today() && owed > 0.001;
  const summary: DocSummary = {
    id: d.id, type: d.type === 'quote' ? 'quote' : 'invoice', number: d.number, clientName: d.clientName,
    issueDate: d.issueDate, dueDate: d.dueDate, status: d.status, currency: d.currency, total: d.total,
  };
  const ref = { id: d.id, number: d.number, clientName: d.clientName, amount: isInvoice ? owed : total, currency: d.currency, type: d.type };

  // The headline figure: what matters about this document right now.
  let big = money(total, d.currency);
  let line = '';
  if (d.status === 'void') { line = 'Cancelled. The number is kept, and it is out of what you are owed.'; }
  else if (d.status === 'draft') { line = 'A draft. Nobody has seen it, so nothing is owed and nobody is chased.'; }
  else if (d.type === 'quote') {
    line = d.decision === 'accepted' ? `Accepted${d.decisionBy ? ` by ${d.decisionBy}` : ''}${d.decisionAt ? ` on ${say(d.decisionAt.slice(0, 10))}` : ''}.`
      : d.decision === 'declined' ? 'They said no to this one.'
        : d.status === 'accepted' ? 'Accepted, and already turned into an invoice.'
          : `Waiting for their answer.${d.dueDate ? ` Good until ${say(d.dueDate)}.` : ''}`;
  } else if (isInvoice) {
    if (owed <= 0.001) { big = `${money(total, d.currency)} paid`; line = 'Settled in full.'; }
    else {
      big = `${money(owed, d.currency)} owed`;
      const part = owed < total - 0.001 ? `That is what is left of ${money(total, d.currency)}. ` : '';
      line = late
        ? `${part}It was due ${say(d.dueDate)}, ${daysLate(d.dueDate!)} days ago. ${d.lastReminderOn ? `Last reminded ${say(d.lastReminderOn)}.` : 'Not chased yet.'}`
        : `${part}${d.dueDate ? `Due ${say(d.dueDate)}.` : 'No due date.'}${d.lastReminderOn ? ` Reminded ${say(d.lastReminderOn)}.` : ''}`;
    }
  }

  async function makeInvoice() {
    setBusy(true);
    try {
      const r = await apiPost<{ document: { id: number; number: string } }>(`/documents/${d.id}/convert`);
      refresh();
      notify(`${r.document.number} made from ${d.number}, same lines and total. It is a draft until you send it.`);
      onOpen(r.document.id);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'The invoice was not made.', 'error');
    } finally { setBusy(false); }
  }

  // The one thing it needs next, first and filled; anything else beside it.
  const actions: ReactElement[] = [];
  const primary = (label: string, run: () => void) => actions.push(
    <button key={label} disabled={busy} onClick={run} className={`${btnPrimary} min-h-11`}>{label}</button>);
  const second = (label: string, run: () => void) => actions.push(
    <button key={label} disabled={busy} onClick={run} className={`${btnSecondary} min-h-11`}>{label}</button>);
  if (d.status === 'draft') primary('Send', () => setSheet('send'));
  else if (isInvoice && d.status === 'sent' && owed > 0.001) {
    if (late) { primary('Chase', () => setSheet('chase')); second('Paid', () => setPaying(true)); }
    else { primary('Paid', () => setPaying(true)); second('Send again', () => setSheet('send')); }
  } else if (d.type === 'quote' && d.status === 'sent') {
    if (d.decision === 'accepted') primary('Make the invoice', makeInvoice);
    else if (d.decision !== 'declined') second('Remind', () => setSheet('remind'));
    if (d.decision !== 'accepted') second('They said yes, make the invoice', makeInvoice);
  }
  if (isInvoice && d.status === 'paid') second('Payments', () => setPaying(true));

  const sub = Number(d.subtotal);
  const disc = Number(d.discountAmount);
  const vat = Number(d.taxAmount);
  const dep = Number(d.depositAmount);

  return (
    <Modal onClose={onClose} variant="drawer" labelledBy="doc-view-title">
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 p-5">
          <div className="min-w-0">
            <p className="text-xs text-slate-500">{kind}</p>
            <h2 id="doc-view-title" className="num font-display text-xl font-bold text-slate-100">{d.number}</h2>
            <p className="mt-0.5 text-sm text-slate-300">
              {d.folderId
                ? <button onClick={() => { onClose(); navigateTo('clients', { client: String(d.folderId) }); }} className="text-[var(--accent)] hover:underline">{d.clientName}</button>
                : d.clientName}
              <span className="text-slate-500">{data.issuer?.name ? `, from ${data.issuer.name}` : ''}</span>
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section>
            <div className={`num font-display text-3xl font-bold ${late ? 'text-red-300' : 'text-slate-100'}`}>{big}</div>
            <p className="mt-1 flex items-start gap-1.5 text-sm text-slate-400">
              {late ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-400" />
                : d.status === 'paid' || (isInvoice && owed <= 0.001) ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" />
                  : <Clock size={15} className="mt-0.5 shrink-0 text-slate-500" />}
              <span>{line}</span>
            </p>
          </section>

          {actions.length > 0 && <div className="flex flex-wrap gap-2">{actions}</div>}

          <section className="rounded-xl border border-slate-800">
            {data.lines.map((l, i) => (
              <div key={i} className="flex items-start justify-between gap-3 border-b border-slate-800 px-3 py-2.5 text-sm last:border-b-0">
                <span className="min-w-0">
                  <span className="block text-slate-200">{l.description}</span>
                  {l.detail && <span className="block text-xs text-slate-500">{l.detail}</span>}
                  <span className="num block text-xs text-slate-500">{Number(l.quantity)} x {money(l.unitPrice, d.currency)}</span>
                </span>
                <span className="num shrink-0 text-slate-200">{money(l.amount, d.currency)}</span>
              </div>
            ))}
            <div className="space-y-1 border-t border-slate-800 bg-slate-900/40 px-3 py-2.5 text-sm">
              <Row label="Subtotal" value={money(sub, d.currency)} />
              {disc > 0.001 && <Row label="Discount" value={`-${money(disc, d.currency)}`} />}
              {vat > 0.001 && <Row label={`VAT ${Number(d.taxRate)}%`} value={money(vat, d.currency)} />}
              <Row label="Total" value={money(total, d.currency)} strong />
              {dep > 0.001 && <Row label="Deposit to start" value={money(dep, d.currency)} />}
            </div>
          </section>

          {isInvoice && (pays.data?.payments.length || pays.data?.credits.length) ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Money in</h3>
              <div className="rounded-xl border border-slate-800">
                {pays.data!.payments.map((p) => (
                  <div key={`p${p.id}`} className="flex justify-between gap-3 border-b border-slate-800 px-3 py-2 text-sm last:border-b-0">
                    <span className="text-slate-400">{say(p.paidOn)}{p.method ? `, ${p.method}` : ''}</span>
                    <span className="num text-slate-200">{money(p.amount, d.currency)}</span>
                  </div>
                ))}
                {pays.data!.credits.map((c) => (
                  <div key={`c${c.id}`} className="flex justify-between gap-3 border-b border-slate-800 px-3 py-2 text-sm last:border-b-0">
                    <span className="text-slate-400">Credit note {c.number}</span>
                    <span className="num text-slate-200">-{money(c.total, d.currency)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {isInvoice && d.status !== 'draft' && d.status !== 'void' && (
            <ReminderPanel docId={d.id} currency={d.currency} folderId={d.folderId ?? null} />
          )}

          {d.notes && (
            <section>
              <h3 className="mb-1 text-sm font-semibold text-slate-200">Note on it</h3>
              <p className="whitespace-pre-line text-sm text-slate-400">{d.notes}</p>
            </section>
          )}

          <p className="text-xs text-slate-500">Issued {say(d.issueDate)}{d.dueDate ? `, ${d.type === 'quote' ? 'good until' : 'due'} ${say(d.dueDate)}` : ''}.</p>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-800 p-4">
          <button onClick={() => setPrinting(true)} className={`${btnSecondary} inline-flex min-h-10 items-center gap-1.5`}><Printer size={14} /> PDF</button>
          {d.status !== 'void' && (
            <button onClick={() => onEdit(d.id, d.type)} className={`${btnSecondary} inline-flex min-h-10 items-center gap-1.5`}>
              <Pencil size={14} /> Edit
            </button>
          )}
          {docType !== 'credit_note' && (
            <button disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                const r = await apiPost<{ document: { id: number; number: string; type: string } }>(`/documents/${d.id}/duplicate`, {});
                refresh();
                notify(`${r.document.number} made as a draft copy. Change what you need, then send it.`);
                onEdit(r.document.id, r.document.type);
              } catch (e) {
                notify(e instanceof Error ? e.message : 'Could not copy that document.', 'error');
              } finally { setBusy(false); }
            }} className={`${btnSecondary} inline-flex min-h-10 items-center gap-1.5`}>
              <Copy size={14} /> Duplicate
            </button>
          )}
        </div>
      </div>

      {sheet && <DocActionSheet doc={ref} action={sheet} onClose={() => setSheet(null)} />}
      {paying && <PaymentsModal doc={summary} onClose={() => { setPaying(false); refresh(); }} />}
      {printing && <PrintView id={d.id} onClose={() => setPrinting(false)} />}
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'font-semibold text-slate-100' : 'text-slate-400'}`}>
      <span>{label}</span><span className="num">{value}</span>
    </div>
  );
}
