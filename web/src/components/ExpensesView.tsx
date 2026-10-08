import { useState } from 'react';
import { useFromBusiness, PICK_BUSINESS } from './FromBusiness';
import { StandingCosts } from './StandingCosts';
import { confirmDialog, notify } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, Receipt, Paperclip, Search, Download } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { Skeleton } from './ui';
import type { Expense, Folder } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';
import { Modal } from './Modal';
import { money as fmt } from '../lib/money';
import { useCurrency } from '../lib/useCurrency';
import { useActingBusiness } from '../lib/useActingBusiness';
import { useUrlAction } from '../lib/urlAction';
import { Page, PageHeader, PageBody } from './PageHeader';

const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * Which stretch of time the list covers. It used to be every expense ever, under a
 * "Total logged" figure that grew forever and answered no question anyone asks.
 */
type Period = 'month' | 'last-month' | 'year' | '12m' | 'all';
const PERIODS: { key: Period; label: string }[] = [
  { key: 'month', label: 'This month' }, { key: 'last-month', label: 'Last month' },
  { key: 'year', label: 'This year' }, { key: '12m', label: 'Last 12 months' }, { key: 'all', label: 'Everything' },
];
function rangeOf(p: Period): { from?: string; to?: string } {
  const now = new Date();
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (p === 'month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)) };
  if (p === 'last-month') return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  if (p === 'year') return { from: `${now.getFullYear()}-01-01` };
  if (p === '12m') return { from: ymd(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)) };
  return {};
}

/** Send a receipt file to the server for one expense. */
async function uploadReceipt(expenseId: number, file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/v1/expenses/${expenseId}/receipt`, { method: 'POST', body: form, credentials: 'same-origin' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? 'The receipt could not be saved.');
  }
}

export function ExpensesView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  // What this business bills in. Both of these screens used to print a rand sign
  // regardless of the setting, so a dollar business saw its own prices mislabelled.
  // A one-business workspace under "All businesses" is that business, so its costs are
  // labelled in its currency rather than the workspace fallback.
  const acting = useActingBusiness(businessId);
  const cur = useCurrency(acting.id ?? businessId);
  const money = (v: string | number) => fmt(v, cur);
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  useUrlAction('new', () => setEditing('new'));
  const bizParam = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const newBusinessId = businessId === 'all' ? undefined : businessId;

  const [period, setPeriod] = useState<Period>('month');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [noReceipt, setNoReceipt] = useState(false);
  const range = rangeOf(period);
  const rangeQ = [range.from && `from=${range.from}`, range.to && `to=${range.to}`].filter(Boolean).join('&');
  const listUrl = `/expenses${bizParam}${rangeQ ? `${bizParam ? '&' : '?'}${rangeQ}` : ''}`;
  const { data, isLoading } = useQuery({
    queryKey: ['expenses', businessId, period],
    queryFn: () => apiGet<{ expenses: Expense[]; total: number }>(listUrl),
  });
  const inPeriod = data?.expenses ?? [];
  const categories = [...new Set(inPeriod.map((e) => e.category?.trim()).filter(Boolean) as string[])].sort();
  const q = query.trim().toLowerCase();
  const rows = inPeriod.filter((e) => (!category || (e.category?.trim() || '') === category)
    && (!noReceipt || !e.receiptNodeId)
    && (!q || e.description.toLowerCase().includes(q) || (e.category ?? '').toLowerCase().includes(q)));
  const sum = (list: Expense[], f: (e: Expense) => number) => Math.round(list.reduce((t, e) => t + f(e), 0) * 100) / 100;
  const total = sum(rows, (e) => Number(e.amount));
  const vatTotal = sum(rows, (e) => Number(e.vatAmount ?? 0));
  const missingReceipts = inPeriod.filter((e) => !e.receiptNodeId).length;
  // Where the money went, biggest first: the question behind every expense list.
  const byCategory = [...rows.reduce((m, e) => {
    const k = e.category?.trim() || 'No category';
    return m.set(k, (m.get(k) ?? 0) + Number(e.amount));
  }, new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const attach = useMutation({
    mutationFn: (v: { id: number; file: File }) => uploadReceipt(v.id, v.file),
    onSuccess: () => { invalidate(); notify('Receipt saved. It is also in Files, under Receipts.', 'ok'); },
    onError: (e) => notify(e instanceof Error ? e.message : 'The receipt could not be saved.', 'error'),
  });
  const pickReceipt = (id: number) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    input.onchange = () => { const f = input.files?.[0]; if (f) attach.mutate({ id, file: f }); };
    input.click();
  };
  const exportCsv = () => {
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [['Date', 'Description', 'Category', 'Client', 'Amount', 'VAT', 'Receipt'].map(cell).join(',')]
      .concat(rows.map((e) => [e.incurredOn, e.description, e.category ?? '', clientName(e.folderId) ?? 'Overhead',
        Number(e.amount).toFixed(2), Number(e.vatAmount ?? 0).toFixed(2), e.receiptNodeId ? 'yes' : 'no'].map(cell).join(',')));
    const blob = new Blob([lines.join(String.fromCharCode(13, 10))], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `expenses-${range.from ?? 'all'}${range.to ? `-to-${range.to}` : ''}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const invalidate = () => qc.invalidateQueries({ queryKey: ['expenses'] });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/expenses/${id}`), onSuccess: invalidate });

  // Top-level client/project folders, so an expense can be tagged to whoever it's for.
  const foldersQ = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const clientFolders = (foldersQ.data?.folders ?? []).filter((f) =>
    f.parentId === null && f.pillar === 'delivery' && (businessId === 'all' || f.businessId === businessId));
  const clientName = (id: number | null) => id == null ? null : clientFolders.find((f) => f.id === id)?.name ?? null;

  return (
    <Page>
      <PageHeader view="expenses" title="Expenses"
        subtitle="What this business actually spends. Tag one to a client to see per-client profit in Reports."
        actions={(
          <button onClick={() => setEditing('new')}
            className="flex min-h-10 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 sm:min-h-9">
            <Plus size={15} /> New expense
          </button>
        )} />
      <PageBody>

        <StandingCosts businessId={businessId} currency={cur} />

        {isLoading && <Skeleton className="h-48" />}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Period"
            className="min-h-10 rounded-lg border border-slate-700 bg-slate-900/70 px-2 text-sm text-slate-200 sm:min-h-9">
            {PERIODS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          <label className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an expense" aria-label="Find an expense"
              className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-900/70 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500 sm:min-h-9" />
          </label>
          {categories.length > 0 && (
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category"
              className="min-h-10 rounded-lg border border-slate-700 bg-slate-900/70 px-2 text-sm text-slate-200 sm:min-h-9">
              <option value="">Every category</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {missingReceipts > 0 && (
            <button onClick={() => setNoReceipt((v) => !v)} aria-pressed={noReceipt}
              className={`min-h-10 rounded-lg border px-3 text-sm sm:min-h-9 ${noReceipt ? 'border-amber-500/60 bg-amber-500/15 text-amber-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}>
              No receipt ({missingReceipts})
            </button>
          )}
          {rows.length > 0 && (
            <button onClick={exportCsv} title="Download these as a spreadsheet, for your bookkeeper"
              className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:bg-slate-800 sm:min-h-9">
              <Download size={14} /> Export
            </button>
          )}
        </div>

        {data && (
          <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Spent, {PERIODS.find((x) => x.key === period)!.label.toLowerCase()}</div>
              <div className="num mt-1 text-xl font-semibold text-slate-100">{money(total)}</div>
              {vatTotal > 0 && <div className="mt-0.5 text-[11px] text-slate-500">including VAT of <span className="num">{money(vatTotal)}</span></div>}
            </div>
            {byCategory.length > 1 && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Where it went</div>
                <div className="space-y-1.5">
                  {byCategory.slice(0, 5).map(([k, v]) => (
                    <button key={k} onClick={() => setCategory(k === 'No category' ? '' : (category === k ? '' : k))}
                      className="flex w-full items-center gap-2 text-left text-xs">
                      <span className="w-28 shrink-0 truncate text-slate-300">{k}</span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                        <span className="block h-full rounded-full bg-violet-500/70" style={{ width: `${(v / (byCategory[0]![1] || 1)) * 100}%` }} />
                      </span>
                      <span className="num w-24 shrink-0 text-right text-slate-200">{money(v)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Category</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Client</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium"><span className="sr-only">Receipt</span></th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-500">
                  <Receipt size={22} className="mx-auto mb-2 opacity-50" />
                  {inPeriod.length ? 'Nothing matches.' : period === 'all' ? 'Nothing logged yet.' : 'Nothing logged in this period.'}
                </td></tr>
              )}
              {rows.map((e) => (
                <tr key={e.id} className="group border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-400">{e.incurredOn}</td>
                  <td className="px-3 py-2 font-medium text-slate-200">
                    {e.description}
                    {e.recurringExpenseId && <span className="ml-1.5 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal text-slate-500" title="Written by a standing cost">repeats</span>}
                  </td>
                  <td className="hidden px-3 py-2 text-slate-400 sm:table-cell">{e.category ?? '-'}</td>
                  <td className="hidden px-3 py-2 text-slate-400 sm:table-cell">{clientName(e.folderId) ?? <span className="text-slate-600">overhead</span>}</td>
                  <td className="px-3 py-2 text-right num text-slate-100">{money(e.amount)}</td>
                  <td className="px-3 py-2">
                    {e.receiptNodeId ? (
                      <a href={`/api/v1/storage/${e.receiptNodeId}/download`} title="Open the receipt"
                        className="inline-flex items-center gap-1 text-[11px] text-green-300 hover:underline"><Paperclip size={12} /> receipt</a>
                    ) : (
                      <button onClick={() => pickReceipt(e.id)} disabled={attach.isPending} title="Attach a photo or PDF of the slip"
                        className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-200"><Paperclip size={12} /> add</button>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEditing(e)} title="Edit" className="text-slate-500 hover:text-slate-200"><Pencil size={14} /></button>
                      <button onClick={async () => { if (await confirmDialog(`Delete "${e.description}"?`, { danger: true })) del.mutate(e.id); }} title="Delete" className="text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageBody>

      {editing && (
        <ExpenseEditor
          expense={editing === 'new' ? null : editing}
          businessId={newBusinessId}
          clientFolders={clientFolders}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate(); }}
          onReplaceReceipt={(id) => pickReceipt(id)}
        />
      )}
    </Page>
  );
}

function ExpenseEditor({ expense, businessId, clientFolders, categories, onClose, onSaved, onReplaceReceipt }: {
  expense: Expense | null;
  businessId?: number;
  clientFolders: Folder[];
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
  onReplaceReceipt: (id: number) => void;
}) {
  const qc = useQueryClient();
  // A receipt chosen while adding: uploaded straight after the expense is saved.
  const [receipt, setReceipt] = useState<File | null>(null);
  const removeReceipt = useMutation({
    mutationFn: () => apiDelete(`/expenses/${expense!.id}/receipt`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['expenses'] }); onClose(); },
  });
  const isNew = !expense;
  const [description, setDescription] = useState(expense?.description ?? '');
  const [amount, setAmount] = useState(expense?.amount ?? '');
  const [vat, setVat] = useState(expense?.vatAmount ?? '');
  const [category, setCategory] = useState(expense?.category ?? '');
  const [incurredOn, setIncurredOn] = useState(expense?.incurredOn ?? todayStr());
  const [folderId, setFolderId] = useState<string>(expense?.folderId != null ? String(expense.folderId) : '');
  const [error, setError] = useState<string | null>(null);
  const from = useFromBusiness(businessId, folderId ? Number(folderId) : null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        description: description.trim(), amount: Number(amount) || 0,
        vatAmount: vat.trim() ? Number(vat) : null,
        category: category.trim() || null, incurredOn,
        folderId: folderId ? Number(folderId) : null,
        ...(isNew && from.id ? { businessId: from.id } : {}),
      };
      if (isNew && from.missing) throw new Error(PICK_BUSINESS);
      if (!isNew) return apiPatch(`/expenses/${expense!.id}`, body);
      return apiPost<{ expense: Expense }>('/expenses', body).then(async (r) => {
        if (receipt) {
          try { await uploadReceipt(r.expense.id, receipt); } catch (e) {
            notify(`The expense is saved, but the receipt was not: ${e instanceof Error ? e.message : 'try again from the list'}.`, 'error');
          }
        }
        return r;
      });
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  return (
    <Modal onClose={onClose} variant="panel">
      <form onSubmit={(e) => { e.preventDefault(); if (description.trim()) save.mutate(); }}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{isNew ? 'New expense' : 'Edit expense'}</h2>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>
        {isNew && from.element && <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900/40 p-3">{from.element}</div>}

        <label className="mb-1 block text-xs text-slate-400">Description</label>
        <input autoFocus value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Adobe subscription"
          className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />

        <div className="mb-3 grid grid-cols-3 gap-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Amount</label>
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400" title="Input VAT contained in the amount, for the VAT return">VAT</label>
            <input type="number" step="0.01" value={vat} onChange={(e) => setVat(e.target.value)} placeholder="0.00"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Date</label>
            <input type="date" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />
          </div>
        </div>

        <label className="mb-1 block text-xs text-slate-400">Category (optional)</label>
        {/* The categories already used, offered as you type, so "Software" and
            "software " do not end up as two lines in the report. */}
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Software, payroll or supplies"
          list="expense-categories"
          className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />

        <label className="mb-1 block text-xs text-slate-400">Client (optional - leave blank for general overhead)</label>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500">
          <option value="">General overhead</option>
          {clientFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>

        <datalist id="expense-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>

        <div className="mb-4 rounded-lg border border-slate-800 p-3">
          <div className="mb-1 text-xs text-slate-400">Receipt</div>
          {isNew ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <Paperclip size={14} />
              <span className="truncate">{receipt ? receipt.name : 'Attach a photo or PDF of the slip'}</span>
              <input type="file" accept="image/*,application/pdf" className="sr-only"
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
            </label>
          ) : expense!.receiptNodeId ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <a href={`/api/v1/storage/${expense!.receiptNodeId}/download`} className="inline-flex items-center gap-1.5 text-green-300 hover:underline"><Paperclip size={14} /> Open receipt</a>
              <button type="button" onClick={() => { onClose(); onReplaceReceipt(expense!.id); }} className="text-xs text-slate-400 hover:text-slate-200">Replace</button>
              <button type="button" onClick={async () => { if (await confirmDialog('Remove this receipt? The file is deleted from Files too.', { danger: true, confirmLabel: 'Remove' })) removeReceipt.mutate(); }}
                className="text-xs text-red-300 hover:text-red-200">Remove</button>
            </div>
          ) : (
            <button type="button" onClick={() => { onClose(); onReplaceReceipt(expense!.id); }}
              className="inline-flex items-center gap-1.5 text-sm text-slate-300 hover:text-slate-100"><Paperclip size={14} /> Attach a photo or PDF</button>
          )}
          <p className="mt-1 text-[11px] text-slate-500">Kept in Files, under Receipts. SARS expects the slip behind every expense you claim.</p>
        </div>

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={!description.trim() || save.isPending}
          className="w-full rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {save.isPending ? 'Saving' : isNew ? 'Add expense' : 'Save changes'}
        </button>
      </form>
    </Modal>
  );
}
