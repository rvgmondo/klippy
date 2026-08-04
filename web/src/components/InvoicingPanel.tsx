import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../lib/api';
import { ErrorNote } from './ErrorNote';

interface Invoicing {
  bizAddress: string | null; bizTaxNumber: string | null; bizRegNumber: string | null;
  bankDetails: string | null; invoiceFooter: string | null; invoiceAccent: string;
  defaultTaxRate: number | null; defaultDueDays: number;
}

const ACCENTS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#111827'];

/**
 * The "from" side of every quote and invoice, plus the defaults a new one starts with.
 * All of it is optional; it just turns a bare table into a document that looks like it
 * came from a real business.
 */
export function InvoicingPanel() {
  const qc = useQueryClient();
  const { data, error, refetch } = useQuery({
    queryKey: ['invoicing'],
    queryFn: () => apiGet<{ invoicing: Invoicing }>('/account/invoicing'),
    retry: false,
  });

  const [form, setForm] = useState<Invoicing | null>(null);
  useEffect(() => { if (data && !form) setForm(data.invoicing); }, [data, form]);

  const save = useMutation({
    mutationFn: (body: Partial<Invoicing>) => apiPatch('/account', body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invoicing'] }); setSaved(true); setTimeout(() => setSaved(false), 2000); },
  });
  const [saved, setSaved] = useState(false);

  if (error) return <ErrorNote error={error} onRetry={() => refetch()} />;
  if (!form) return <p className="text-sm text-slate-500">Loading...</p>;

  const set = <K extends keyof Invoicing>(k: K, v: Invoicing[K]) => setForm({ ...form, [k]: v });
  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]';
  const label = 'mb-1 block text-xs font-medium text-slate-400';

  function submit() {
    if (!form) return;
    save.mutate({
      bizAddress: form.bizAddress ?? '', bizTaxNumber: form.bizTaxNumber ?? '',
      bizRegNumber: form.bizRegNumber ?? '', bankDetails: form.bankDetails ?? '',
      invoiceFooter: form.invoiceFooter ?? '', invoiceAccent: form.invoiceAccent,
      defaultTaxRate: form.defaultTaxRate, defaultDueDays: form.defaultDueDays,
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        These appear on every quote and invoice you print or email. Add your logo under the Branding tab.
      </p>

      <div>
        <label className={label}>Your address</label>
        <textarea className={`${field} min-h-[70px] resize-y`} value={form.bizAddress ?? ''}
          onChange={(e) => set('bizAddress', e.target.value)}
          placeholder={'Mondobase\n12 Main Road\nCape Town, 8001'} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>VAT / tax number</label>
          <input className={field} value={form.bizTaxNumber ?? ''} onChange={(e) => set('bizTaxNumber', e.target.value)} placeholder="4123456789" />
        </div>
        <div>
          <label className={label}>Company registration</label>
          <input className={field} value={form.bizRegNumber ?? ''} onChange={(e) => set('bizRegNumber', e.target.value)} placeholder="2021/123456/07" />
        </div>
      </div>

      <div>
        <label className={label}>Bank details for payment</label>
        <textarea className={`${field} min-h-[70px] resize-y`} value={form.bankDetails ?? ''}
          onChange={(e) => set('bankDetails', e.target.value)}
          placeholder={'FNB Business Cheque\nAcc: 62812345678\nBranch: 250655\nRef: your invoice number'} />
        <p className="mt-1 text-[11px] text-slate-500">Shown on invoices so a client can pay by EFT.</p>
      </div>

      <div>
        <label className={label}>Footer note / terms</label>
        <textarea className={`${field} min-h-[60px] resize-y`} value={form.invoiceFooter ?? ''}
          onChange={(e) => set('invoiceFooter', e.target.value)}
          placeholder="Payment due within 14 days. Thank you for your business." />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Default tax rate (%)</label>
          <input type="number" min={0} max={100} step="0.01" className={field}
            value={form.defaultTaxRate ?? ''}
            onChange={(e) => set('defaultTaxRate', e.target.value === '' ? null : Number(e.target.value))}
            placeholder="15" />
          <p className="mt-1 text-[11px] text-slate-500">Prefilled on new invoices. SA VAT is 15.</p>
        </div>
        <div>
          <label className={label}>Payment terms (days)</label>
          <input type="number" min={0} max={365} className={field}
            value={form.defaultDueDays}
            onChange={(e) => set('defaultDueDays', Number(e.target.value))} />
          <p className="mt-1 text-[11px] text-slate-500">Due date = issue date + this.</p>
        </div>
      </div>

      <div>
        <label className={label}>Accent colour on the document</label>
        <div className="flex flex-wrap items-center gap-2">
          {ACCENTS.map((c) => (
            <button key={c} onClick={() => set('invoiceAccent', c)}
              className={`h-7 w-7 rounded-full border-2 ${form.invoiceAccent.toLowerCase() === c.toLowerCase() ? 'border-white' : 'border-transparent'}`}
              style={{ background: c }} title={c} />
          ))}
          <input type="color" value={form.invoiceAccent} onChange={(e) => set('invoiceAccent', e.target.value)}
            className="h-7 w-10 cursor-pointer rounded border border-slate-700 bg-transparent" title="Custom colour" />
        </div>
      </div>

      {save.error && <ErrorNote error={save.error} />}
      <div className="flex items-center gap-3 border-t border-slate-800 pt-4">
        <button onClick={submit} disabled={save.isPending}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-60">
          {save.isPending ? 'Saving...' : 'Save invoicing settings'}
        </button>
        {saved && <span className="text-sm text-violet-300">Saved</span>}
      </div>
    </div>
  );
}
