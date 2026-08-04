import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Upload, Trash2 } from 'lucide-react';
import { apiPatch } from '../lib/api';
import type { Business } from '../lib/types';

const ACCENTS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#111827'];

/**
 * Everything a client sees for one business: its brand (name, logo, colour) and the
 * "from" details on its quotes and invoices. This is the business's own identity,
 * separate from the account, so one login can run several companies that each look
 * like their own business.
 */
export function BusinessSettings({ business, onClose }: { business: Business; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    brandName: business.brandName ?? '',
    bizAddress: business.bizAddress ?? '',
    bizTaxNumber: business.bizTaxNumber ?? '',
    bizRegNumber: business.bizRegNumber ?? '',
    bankDetails: business.bankDetails ?? '',
    invoiceFooter: business.invoiceFooter ?? '',
    invoiceAccent: business.invoiceAccent ?? '#6366f1',
    defaultTaxRate: business.defaultTaxRate != null ? String(Number(business.defaultTaxRate)) : '',
    defaultDueDays: business.defaultDueDays ?? 14,
  });
  const [saved, setSaved] = useState(false);
  const [logoBust, setLogoBust] = useState(0); // force <img> reload after upload
  const [hasLogo, setHasLogo] = useState(!!business.logoPath);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });

  const save = useMutation({
    mutationFn: () => apiPatch(`/businesses/${business.id}`, {
      brandName: form.brandName, bizAddress: form.bizAddress, bizTaxNumber: form.bizTaxNumber,
      bizRegNumber: form.bizRegNumber, bankDetails: form.bankDetails, invoiceFooter: form.invoiceFooter,
      invoiceAccent: form.invoiceAccent,
      defaultTaxRate: form.defaultTaxRate === '' ? null : Number(form.defaultTaxRate),
      defaultDueDays: Number(form.defaultDueDays),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['businesses'] });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    },
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/v1/businesses/${business.id}/logo`, { method: 'POST', credentials: 'same-origin', body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed.');
    },
    onSuccess: () => { setHasLogo(true); setLogoBust(Date.now()); qc.invalidateQueries({ queryKey: ['businesses'] }); },
  });
  const removeLogo = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/businesses/${business.id}/logo`, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) throw new Error('Could not remove the logo.');
    },
    onSuccess: () => { setHasLogo(false); setLogoBust(Date.now()); qc.invalidateQueries({ queryKey: ['businesses'] }); },
  });

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]';
  const label = 'mb-1 block text-xs font-medium text-slate-400';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{business.name}</h2>
            <p className="text-[11px] text-slate-500">Brand and invoicing, as your clients see it</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
          {/* Brand */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Brand</h3>
            <div className="flex items-center gap-4">
              <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
                {hasLogo
                  ? <img src={`/api/v1/businesses/${business.id}/logo?v=${logoBust}`} alt="" className="h-full w-full object-contain" />
                  : <span className="text-xl font-bold text-slate-500">{(form.brandName || business.name)[0]?.toUpperCase()}</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                <input ref={fileRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo.mutate(f); e.target.value = ''; }} />
                <button onClick={() => fileRef.current?.click()} disabled={uploadLogo.isPending}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                  <Upload size={13} /> {uploadLogo.isPending ? 'Uploading...' : 'Upload logo'}
                </button>
                {hasLogo && (
                  <button onClick={() => removeLogo.mutate()} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-red-500/10 hover:text-red-400">
                    <Trash2 size={13} /> Remove
                  </button>
                )}
              </div>
            </div>
            {uploadLogo.error && <p className="text-[11px] text-red-400">{(uploadLogo.error as Error).message}</p>}

            <div>
              <label className={label}>Display name on documents</label>
              <input className={field} value={form.brandName} onChange={(e) => set('brandName', e.target.value)}
                placeholder={business.name} />
              <p className="mt-1 text-[11px] text-slate-500">Leave blank to use the business name ({business.name}).</p>
            </div>

            <div>
              <label className={label}>Accent colour on quotes and invoices</label>
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
          </section>

          {/* Invoicing */}
          <section className="space-y-4 border-t border-slate-800 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Invoicing details</h3>
            <div>
              <label className={label}>Address</label>
              <textarea className={`${field} min-h-[64px] resize-y`} value={form.bizAddress}
                onChange={(e) => set('bizAddress', e.target.value)} placeholder={'12 Main Road\nCape Town, 8001'} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>VAT / tax number</label>
                <input className={field} value={form.bizTaxNumber} onChange={(e) => set('bizTaxNumber', e.target.value)} placeholder="4123456789" />
              </div>
              <div>
                <label className={label}>Company registration</label>
                <input className={field} value={form.bizRegNumber} onChange={(e) => set('bizRegNumber', e.target.value)} placeholder="2021/123456/07" />
              </div>
            </div>
            <div>
              <label className={label}>Bank details for payment</label>
              <textarea className={`${field} min-h-[64px] resize-y`} value={form.bankDetails}
                onChange={(e) => set('bankDetails', e.target.value)} placeholder={'FNB Business Cheque\nAcc: 62812345678\nBranch: 250655'} />
            </div>
            <div>
              <label className={label}>Footer note / terms</label>
              <textarea className={`${field} min-h-[52px] resize-y`} value={form.invoiceFooter}
                onChange={(e) => set('invoiceFooter', e.target.value)} placeholder="Payment due within 14 days. Thank you." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Default tax rate (%)</label>
                <input type="number" min={0} max={100} step="0.01" className={field} value={form.defaultTaxRate}
                  onChange={(e) => set('defaultTaxRate', e.target.value)} placeholder="15" />
              </div>
              <div>
                <label className={label}>Payment terms (days)</label>
                <input type="number" min={0} max={365} className={field} value={form.defaultDueDays}
                  onChange={(e) => set('defaultDueDays', Number(e.target.value))} />
              </div>
            </div>
          </section>
        </div>

        <div className="flex items-center gap-3 border-t border-slate-800 px-5 py-3">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-60">
            {save.isPending ? 'Saving...' : 'Save'}
          </button>
          {saved && <span className="text-sm text-violet-300">Saved</span>}
          {save.error && <span className="text-sm text-red-400">{(save.error as Error).message}</span>}
        </div>
      </div>
    </div>
  );
}
