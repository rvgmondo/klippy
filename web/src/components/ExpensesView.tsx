import { useState } from 'react';
import { confirmDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, Receipt } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { Skeleton } from './ui';
import type { Expense, Folder } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';
import { Modal } from './Modal';
import { money as fmt } from '../lib/money';
import { useCurrency } from '../lib/useCurrency';
import { useUrlAction } from '../lib/urlAction';

const todayStr = () => new Date().toISOString().slice(0, 10);

export function ExpensesView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  // What this business bills in. Both of these screens used to print a rand sign
  // regardless of the setting, so a dollar business saw its own prices mislabelled.
  const cur = useCurrency(businessId);
  const money = (v: string | number) => fmt(v, cur);
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  useUrlAction('new', () => setEditing('new'));
  const bizParam = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const newBusinessId = businessId === 'all' ? undefined : businessId;

  const { data, isLoading } = useQuery({
    queryKey: ['expenses', businessId],
    queryFn: () => apiGet<{ expenses: Expense[]; total: number }>(`/expenses${bizParam}`),
  });
  const rows = data?.expenses ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['expenses'] });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/expenses/${id}`), onSuccess: invalidate });

  // Top-level client/project folders, so an expense can be tagged to whoever it's for.
  const foldersQ = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const clientFolders = (foldersQ.data?.folders ?? []).filter((f) =>
    f.parentId === null && f.pillar === 'delivery' && (businessId === 'all' || f.businessId === businessId));
  const clientName = (id: number | null) => id == null ? null : clientFolders.find((f) => f.id === id)?.name ?? null;

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-1 flex items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-100">Expenses</h1>
          <button onClick={() => setEditing('new')}
            className="ml-auto flex min-h-10 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 sm:min-h-9">
            <Plus size={15} /> New expense
          </button>
        </div>
        <p className="mb-5 text-xs text-slate-500">What this business actually spends. Tag one to a client to see per-client profit in Reports.</p>

        {isLoading && <Skeleton className="h-48" />}
        {data && (
          <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-2.5 text-sm text-slate-300">
            Total logged: <span className="font-semibold text-slate-100">{money(data.total)}</span>
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
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">
                  <Receipt size={22} className="mx-auto mb-2 opacity-50" />
                  Nothing logged yet.
                </td></tr>
              )}
              {rows.map((e) => (
                <tr key={e.id} className="group border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-400">{e.incurredOn}</td>
                  <td className="px-3 py-2 font-medium text-slate-200">{e.description}</td>
                  <td className="hidden px-3 py-2 text-slate-400 sm:table-cell">{e.category ?? '-'}</td>
                  <td className="hidden px-3 py-2 text-slate-400 sm:table-cell">{clientName(e.folderId) ?? <span className="text-slate-600">overhead</span>}</td>
                  <td className="px-3 py-2 text-right num text-slate-100">{money(e.amount)}</td>
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
      </div>

      {editing && (
        <ExpenseEditor
          expense={editing === 'new' ? null : editing}
          businessId={newBusinessId}
          clientFolders={clientFolders}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate(); }}
        />
      )}
    </div>
  );
}

function ExpenseEditor({ expense, businessId, clientFolders, onClose, onSaved }: {
  expense: Expense | null;
  businessId?: number;
  clientFolders: Folder[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !expense;
  const [description, setDescription] = useState(expense?.description ?? '');
  const [amount, setAmount] = useState(expense?.amount ?? '');
  const [vat, setVat] = useState(expense?.vatAmount ?? '');
  const [category, setCategory] = useState(expense?.category ?? '');
  const [incurredOn, setIncurredOn] = useState(expense?.incurredOn ?? todayStr());
  const [folderId, setFolderId] = useState<string>(expense?.folderId != null ? String(expense.folderId) : '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        description: description.trim(), amount: Number(amount) || 0,
        vatAmount: vat.trim() ? Number(vat) : null,
        category: category.trim() || null, incurredOn,
        folderId: folderId ? Number(folderId) : null,
        ...(isNew ? { businessId } : {}),
      };
      return isNew ? apiPost('/expenses', body) : apiPatch(`/expenses/${expense!.id}`, body);
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
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Software, Payroll, Supplies..."
          className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500" />

        <label className="mb-1 block text-xs text-slate-400">Client (optional - leave blank for general overhead)</label>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500">
          <option value="">General overhead</option>
          {clientFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={!description.trim() || save.isPending}
          className="w-full rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {save.isPending ? 'Saving...' : isNew ? 'Add expense' : 'Save changes'}
        </button>
      </form>
    </Modal>
  );
}
