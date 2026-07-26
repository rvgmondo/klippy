import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Printer, Trash2, X, Pencil, ArrowRightLeft, Clock, DollarSign, Mail } from 'lucide-react';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { BusinessSelection } from './BusinessSwitcher';

interface TreeFolder { id: number; parentId: number | null; name: string }

type DocType = 'quote' | 'invoice';
type Status = 'draft' | 'sent' | 'accepted' | 'paid' | 'void';

interface DocSummary {
  id: number; type: DocType; number: string; clientName: string;
  issueDate: string; dueDate: string | null; status: Status; currency: string; total: string;
}
interface Line { description: string; quantity: number; unitPrice: number }
interface FullDoc {
  document: DocSummary & {
    clientEmail: string | null; clientAddress: string | null; taxRate: string;
    subtotal: string; taxAmount: string; notes: string | null;
  };
  lines: (Line & { amount: string })[];
  brand: { name: string; hasLogo: boolean };
}

const STATUS_COLOR: Record<Status, string> = {
  draft: 'bg-slate-700 text-slate-200', sent: 'bg-blue-600/30 text-blue-200',
  accepted: 'bg-violet-600/30 text-violet-200', paid: 'bg-green-600/30 text-green-200',
  void: 'bg-slate-800 text-slate-500 line-through',
};

function money(v: number | string, currency: string) {
  const n = typeof v === 'string' ? Number(v) : v;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n); }
  catch { return `${currency} ${n.toFixed(2)}`; }
}
const todayStr = () => new Date().toISOString().slice(0, 10);

export function BillingView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<DocType>('invoice');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [printing, setPrinting] = useState<number | null>(null);
  const [paying, setPaying] = useState<DocSummary | null>(null);
  const bizParam = businessId === 'all' ? '' : `&businessId=${businessId}`;
  const newBusinessId = businessId === 'all' ? undefined : businessId;

  const { data } = useQuery({
    queryKey: ['documents', tab, businessId],
    queryFn: () => apiGet<{ documents: DocSummary[] }>(`/documents?type=${tab}${bizParam}`),
  });
  const docs = data?.documents ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['documents'] });

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
    onSuccess: (r) => { invalidate(); alert(`Sent to ${r.to}.`); },
    onError: (e) => alert(e instanceof Error ? e.message : 'Could not send.'),
  });

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-slate-900 p-1">
            {(['invoice', 'quote'] as DocType[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${tab === t ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
                {t}s
              </button>
            ))}
          </div>
          <button onClick={() => setEditing('new')}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500">
            <Plus size={15} /> New {tab}
          </button>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-800">
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
                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500">No {tab}s yet.</td></tr>
              )}
              {docs.map((d) => (
                <tr key={d.id} className="group border-t border-slate-800">
                  <td className="px-3 py-2 font-medium text-slate-200">{d.number}</td>
                  <td className="px-3 py-2 text-slate-300">{d.clientName}</td>
                  <td className="hidden px-3 py-2 text-slate-400 sm:table-cell">{d.issueDate}</td>
                  <td className="px-3 py-2">
                    <select value={d.status} onChange={(e) => setStatus.mutate({ id: d.id, status: e.target.value as Status })}
                      className={`rounded-md px-2 py-0.5 text-[11px] ${STATUS_COLOR[d.status]}`}>
                      {(['draft', 'sent', 'accepted', 'paid', 'void'] as Status[]).map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-100">{money(d.total, d.currency)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setPrinting(d.id)} title="Print / PDF" className="text-slate-500 hover:text-slate-200"><Printer size={15} /></button>
                      <button onClick={() => { const m = window.prompt('Optional message to include (blank for default):', ''); if (m !== null) email.mutate({ id: d.id, message: m || undefined }); }} title="Email to client" className="text-slate-500 hover:text-slate-200"><Mail size={14} /></button>
                      <button onClick={() => setEditing(d.id)} title="Edit" className="text-slate-500 hover:text-slate-200"><Pencil size={14} /></button>
                      {d.type === 'invoice' && (
                        <button onClick={() => setPaying(d)} title="Payments" className="text-slate-500 hover:text-green-300"><DollarSign size={14} /></button>
                      )}
                      {d.type === 'quote' && (
                        <button onClick={() => convert.mutate(d.id)} title="Convert to invoice" className="text-slate-500 hover:text-violet-300"><ArrowRightLeft size={14} /></button>
                      )}
                      <button onClick={() => { if (confirm(`Delete ${d.number}?`)) del.mutate(d.id); }} title="Delete" className="text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && <Editor id={editing} type={tab} businessId={newBusinessId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />}
      {printing && <PrintView id={printing} onClose={() => setPrinting(null)} />}
      {paying && <PaymentsModal doc={paying} onClose={() => { setPaying(null); invalidate(); }} />}
    </div>
  );
}

function Editor({ id, type, businessId, onClose, onSaved }: { id: number | 'new'; type: DocType; businessId?: number; onClose: () => void; onSaved: () => void }) {
  const isNew = id === 'new';
  const existing = useQuery({
    queryKey: ['document', id], enabled: !isNew,
    queryFn: () => apiGet<FullDoc>(`/documents/${id}`),
  });

  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientAddress, setClientAddress] = useState('');
  const [issueDate, setIssueDate] = useState(todayStr());
  const [dueDate, setDueDate] = useState('');
  const [taxRate, setTaxRate] = useState(15);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([{ description: '', quantity: 1, unitPrice: 0 }]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(isNew);

  // "Pull from tracked time" state
  const [showTime, setShowTime] = useState(false);
  const [timeFolder, setTimeFolder] = useState<number | ''>('');
  const [timeFrom, setTimeFrom] = useState(() => todayStr().slice(0, 8) + '01');
  const [timeTo, setTimeTo] = useState(todayStr());
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: TreeFolder[] }>('/folders') });
  const clients = (folders.data?.folders ?? []).filter((f) => f.parentId === null);

  const pull = useMutation({
    mutationFn: () => apiGet<{ clientName: string; lines: Line[]; totalHours: number }>(
      `/documents/from-time?folderId=${timeFolder}&from=${timeFrom}&to=${timeTo}`),
    onSuccess: (r) => {
      if (r.lines.length === 0) { setError(`No tracked time for that client between ${timeFrom} and ${timeTo}.`); return; }
      setError(null);
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

  // Hydrate from the existing document once.
  if (!isNew && existing.data && !ready) {
    const d = existing.data.document;
    setClientName(d.clientName); setClientEmail(d.clientEmail ?? ''); setClientAddress(d.clientAddress ?? '');
    setIssueDate(d.issueDate); setDueDate(d.dueDate ?? ''); setTaxRate(Number(d.taxRate));
    setNotes(d.notes ?? '');
    setLines(existing.data.lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })));
    setReady(true);
  }

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const tax = subtotal * (taxRate / 100);
  const currency = existing.data?.document.currency ?? 'ZAR';

  const save = useMutation({
    mutationFn: () => {
      const body = {
        type, clientName: clientName.trim(), clientEmail: clientEmail.trim() || null,
        clientAddress: clientAddress.trim() || null, issueDate, dueDate: dueDate || null,
        taxRate, notes: notes.trim() || null,
        ...(isNew && businessId ? { businessId } : {}),
        lines: lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity) || 0, unitPrice: Number(l.unitPrice) || 0 })),
      };
      return isNew ? apiPost('/documents', body) : apiPut(`/documents/${id}`, body);
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500';

  return (
    <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div className="my-auto w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-950 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100 capitalize">{isNew ? `New ${type}` : `Edit ${type}`}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input className={field} placeholder="Client name" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          <input className={field} placeholder="Client email (optional)" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} />
        </div>
        <textarea className={field + ' mt-3'} placeholder="Client address (optional)" value={clientAddress} onChange={(e) => setClientAddress(e.target.value)} />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><label className="mb-1 block text-[11px] text-slate-500">Issue date</label><input type="date" className={field} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></div>
          <div><label className="mb-1 block text-[11px] text-slate-500">{type === 'quote' ? 'Valid until' : 'Due date'}</label><input type="date" className={field} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
          <div><label className="mb-1 block text-[11px] text-slate-500">Tax %</label><input type="number" className={field} value={taxRate} onChange={(e) => setTaxRate(Number(e.target.value))} /></div>
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
                    className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-500 disabled:opacity-60">
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
          {lines.map((l, i) => (
            <div key={i} className="mb-2 grid grid-cols-12 gap-2">
              <input className={field + ' col-span-6'} placeholder="Item or service" value={l.description}
                onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
              <input type="number" className={field + ' col-span-2 text-right'} value={l.quantity}
                onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, quantity: Number(e.target.value) } : x))} />
              <input type="number" className={field + ' col-span-3 text-right'} value={l.unitPrice}
                onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unitPrice: Number(e.target.value) } : x))} />
              <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="col-span-1 grid place-items-center text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
            </div>
          ))}
          <button onClick={() => setLines([...lines, { description: '', quantity: 1, unitPrice: 0 }])}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            <Plus size={13} /> Add line
          </button>
        </div>

        <div className="mt-4 flex justify-end">
          <div className="w-56 space-y-1 text-sm">
            <div className="flex justify-between text-slate-400"><span>Subtotal</span><span className="tabular-nums">{money(subtotal, currency)}</span></div>
            <div className="flex justify-between text-slate-400"><span>Tax ({taxRate}%)</span><span className="tabular-nums">{money(tax, currency)}</span></div>
            <div className="flex justify-between border-t border-slate-800 pt-1 font-semibold text-slate-100"><span>Total</span><span className="tabular-nums">{money(subtotal + tax, currency)}</span></div>
          </div>
        </div>

        <textarea className={field + ' mt-3'} placeholder="Notes / payment terms (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {error && <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <div className="mt-4 flex gap-2">
          <button onClick={() => clientName.trim() ? save.mutate() : setError('Client name is required.')} disabled={save.isPending}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60">
            {save.isPending ? 'Saving...' : 'Save'}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200">Cancel</button>
        </div>
      </div>
    </div>
  );
}

interface Payment { id: number; amount: string; paidOn: string; method: string | null; note: string | null }
function PaymentsModal({ doc, onClose }: { doc: DocSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ['payments', doc.id];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiGet<{ payments: Payment[]; paid: number; outstanding: number; total: number }>(`/documents/${doc.id}/payments`),
  });
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(todayStr());
  const [method, setMethod] = useState('');
  const invalidate = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['documents'] }); };
  const add = useMutation({
    mutationFn: () => apiPost(`/documents/${doc.id}/payments`, { amount: Number(amount), paidOn, method: method.trim() || null }),
    onSuccess: () => { setAmount(''); setMethod(''); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/payments/${id}`), onSuccess: invalidate });
  const field = 'rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Payments · {doc.number}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className="mb-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-slate-800 py-2"><div className="text-[11px] text-slate-500">Total</div><div className="text-sm font-medium text-slate-200">{money(data?.total ?? doc.total, doc.currency)}</div></div>
          <div className="rounded-lg border border-slate-800 py-2"><div className="text-[11px] text-slate-500">Paid</div><div className="text-sm font-medium text-green-400">{money(data?.paid ?? 0, doc.currency)}</div></div>
          <div className="rounded-lg border border-slate-800 py-2"><div className="text-[11px] text-slate-500">Outstanding</div><div className="text-sm font-medium text-amber-400">{money(data?.outstanding ?? 0, doc.currency)}</div></div>
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          <input className={field + ' w-24'} type="number" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className={field} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          <input className={field + ' w-24'} placeholder="Method" value={method} onChange={(e) => setMethod(e.target.value)} />
          <button onClick={() => Number(amount) > 0 && add.mutate()} disabled={!(Number(amount) > 0)}
            className="rounded-lg bg-violet-600 px-3 py-2 text-sm text-white hover:bg-violet-500 disabled:opacity-60">Record</button>
        </div>

        <div className="space-y-1">
          {(data?.payments ?? []).length === 0 && <p className="text-sm text-slate-500">No payments recorded.</p>}
          {(data?.payments ?? []).map((p) => (
            <div key={p.id} className="group flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-1.5 text-sm">
              <span className="text-slate-300">{p.paidOn}</span>
              <span className="text-slate-500">{p.method}</span>
              <span className="ml-auto tabular-nums text-slate-200">{money(p.amount, doc.currency)}</span>
              <button onClick={() => del.mutate(p.id)} className="text-slate-600 hover:text-red-400"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PrintView({ id, onClose }: { id: number; onClose: () => void }) {
  const { account } = useAuth();
  const { data } = useQuery({ queryKey: ['document', id], queryFn: () => apiGet<FullDoc>(`/documents/${id}`) });
  if (!data) return null;
  const d = data.document;
  const cur = d.currency;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div className="mx-auto my-4 max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="no-print mb-3 flex justify-end gap-2">
          <button onClick={() => window.print()} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">
            <Printer size={15} /> Print / Save as PDF
          </button>
          <button onClick={onClose} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Close</button>
        </div>

        <div className="print-area rounded-xl bg-white p-8 text-slate-900">
          <div className="mb-8 flex items-start justify-between">
            <div className="flex items-center gap-3">
              {account?.hasLogo && <img src="/api/v1/account/logo" alt="" className="h-12 w-12 rounded object-contain" />}
              <div>
                <div className="text-xl font-bold">{data.brand.name}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold uppercase tracking-wide">{d.type}</div>
              <div className="text-sm text-slate-600">{d.number}</div>
            </div>
          </div>

          <div className="mb-6 flex justify-between text-sm">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Bill to</div>
              <div className="font-medium">{d.clientName}</div>
              {d.clientEmail && <div className="text-slate-600">{d.clientEmail}</div>}
              {d.clientAddress && <div className="whitespace-pre-wrap text-slate-600">{d.clientAddress}</div>}
            </div>
            <div className="text-right">
              <div><span className="text-slate-500">Issued: </span>{d.issueDate}</div>
              {d.dueDate && <div><span className="text-slate-500">{d.type === 'quote' ? 'Valid until: ' : 'Due: '}</span>{d.dueDate}</div>}
            </div>
          </div>

          <table className="mb-6 w-full text-sm">
            <thead>
              <tr className="border-b-2 border-slate-300 text-left">
                <th className="py-2">Description</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Unit</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-200">
                  <td className="py-2">{l.description}</td>
                  <td className="py-2 text-right tabular-nums">{Number(l.quantity)}</td>
                  <td className="py-2 text-right tabular-nums">{money(l.unitPrice, cur)}</td>
                  <td className="py-2 text-right tabular-nums">{money(l.amount, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mb-6 flex justify-end">
            <div className="w-64 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="tabular-nums">{money(d.subtotal, cur)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Tax ({Number(d.taxRate)}%)</span><span className="tabular-nums">{money(d.taxAmount, cur)}</span></div>
              <div className="flex justify-between border-t-2 border-slate-300 pt-1 text-base font-bold"><span>Total</span><span className="tabular-nums">{money(d.total, cur)}</span></div>
            </div>
          </div>

          {d.notes && (
            <div className="border-t border-slate-200 pt-4 text-sm">
              <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Notes</div>
              <div className="whitespace-pre-wrap text-slate-700">{d.notes}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
