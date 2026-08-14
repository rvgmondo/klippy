import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Upload, Trash2 } from 'lucide-react';
import { apiGet, apiPatch, apiPut, apiDelete } from '../lib/api';
import type { Business } from '../lib/types';
import { fontsFor, loadFont } from '../lib/fonts';
import { useCurrencyOptions } from '../lib/useCurrency';
import { useAuth } from '../lib/auth';

const ACCENTS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#111827'];

/** The sections a business carries, so the Settings page can show one at a time. */
export type BusinessSection = 'brand' | 'invoicing' | 'reminders' | 'email' | 'access';

/**
 * Everything a client sees for one business: its brand (name, logo, colour) and the
 * "from" details on its quotes and invoices. This is the business's own identity,
 * separate from the account, so one login can run several companies that each look
 * like their own business.
 *
 * Modal wrapper, kept for the quick jump from a business dashboard. The Settings
 * page renders the same panels inline, one section at a time.
 */
export function BusinessSettings({ business, onClose }: { business: Business; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Modal onClose={onClose} variant="panel">
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{business.name}</h2>
            <p className="text-[11px] text-slate-500">Brand and invoicing, as your clients see it</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <BusinessSettingsPanel business={business} />
        </div>
      </div>
    </Modal>
  );
}

/**
 * The business settings themselves, with no modal chrome. `only` narrows it to a
 * single section so the Settings page can give each one its own nav entry instead
 * of stacking five of them into one long scroll.
 */
export function BusinessSettingsPanel({ business, only }: { business: Business; only?: BusinessSection }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    brandName: business.brandName ?? '',
    currency: business.currency ?? '',
    bizAddress: business.bizAddress ?? '',
    bizTaxNumber: business.bizTaxNumber ?? '',
    bizRegNumber: business.bizRegNumber ?? '',
    bankDetails: business.bankDetails ?? '',
    invoiceFooter: business.invoiceFooter ?? '',
    invoiceHeaderHtml: business.invoiceHeaderHtml ?? '',
    invoiceFooterHtml: business.invoiceFooterHtml ?? '',
    prefixInvoice: business.prefixInvoice ?? '',
    prefixQuote: business.prefixQuote ?? '',
    prefixCreditNote: business.prefixCreditNote ?? '',
    seqStartInvoice: business.seqStartInvoice != null ? String(business.seqStartInvoice) : '',
    seqStartQuote: business.seqStartQuote != null ? String(business.seqStartQuote) : '',
    seqStartCreditNote: business.seqStartCreditNote != null ? String(business.seqStartCreditNote) : '',
    invoiceAccent: business.invoiceAccent ?? '#6366f1',
    fontDisplay: business.fontDisplay ?? '',
    fontBody: business.fontBody ?? '',
    defaultTaxRate: business.defaultTaxRate != null ? String(Number(business.defaultTaxRate)) : '',
    defaultDueDays: business.defaultDueDays ?? 14,
    remindersEnabled: business.remindersEnabled ?? true,
    reminderOffsets: (business.reminderOffsets && business.reminderOffsets.length ? business.reminderOffsets : [-3, 0, 7]).join(', '),
    suspendAfterDays: business.suspendAfterDays != null ? String(business.suspendAfterDays) : '',
  });
  const [saved, setSaved] = useState(false);
  const [logoBust, setLogoBust] = useState(0); // force <img> reload after upload
  const [hasLogo, setHasLogo] = useState(!!business.logoPath);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });
  const currencies = useCurrencyOptions();
  const { account } = useAuth();
  const workspaceCurrency = account?.currency ?? 'ZAR';
  const show = (s: BusinessSection) => !only || only === s;
  // Brand, invoicing and reminders share one save, so any of them shows the button.
  const showSave = show('brand') || show('invoicing') || show('reminders');

  const save = useMutation({
    mutationFn: () => apiPatch(`/businesses/${business.id}`, {
      brandName: form.brandName, currency: form.currency || null,
      bizAddress: form.bizAddress, bizTaxNumber: form.bizTaxNumber,
      bizRegNumber: form.bizRegNumber, bankDetails: form.bankDetails, invoiceFooter: form.invoiceFooter,
      invoiceHeaderHtml: form.invoiceHeaderHtml || null,
      invoiceFooterHtml: form.invoiceFooterHtml || null,
      prefixInvoice: form.prefixInvoice, prefixQuote: form.prefixQuote,
      prefixCreditNote: form.prefixCreditNote,
      seqStartInvoice: form.seqStartInvoice === '' ? null : Number(form.seqStartInvoice),
      seqStartQuote: form.seqStartQuote === '' ? null : Number(form.seqStartQuote),
      seqStartCreditNote: form.seqStartCreditNote === '' ? null : Number(form.seqStartCreditNote),
      invoiceAccent: form.invoiceAccent,
      fontDisplay: form.fontDisplay || null,
      fontBody: form.fontBody || null,
      defaultTaxRate: form.defaultTaxRate === '' ? null : Number(form.defaultTaxRate),
      defaultDueDays: Number(form.defaultDueDays),
      remindersEnabled: form.remindersEnabled,
      // "-3, 0, 7" -> [-3, 0, 7]; empty means the default schedule.
      reminderOffsets: form.reminderOffsets.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n)),
      suspendAfterDays: form.suspendAfterDays === '' ? null : Number(form.suspendAfterDays),
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
    <>
      <div className="space-y-6">
          {/* Brand */}
          {show('brand') && <section className="space-y-4">
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
            <LogoStatus businessId={business.id} bust={logoBust} />

            <div>
              <label className={label}>Display name on documents</label>
              <input className={field} value={form.brandName} onChange={(e) => set('brandName', e.target.value)}
                placeholder={business.name} />
              <p className="mt-1 text-[11px] text-slate-500">Leave blank to use the business name ({business.name}).</p>
            </div>

            <div>
              <label className={label}>Brand colour</label>
              <div className="flex flex-wrap items-center gap-2">
                {ACCENTS.map((c) => (
                  <button key={c} onClick={() => set('invoiceAccent', c)}
                    className={`h-7 w-7 rounded-full border-2 ${form.invoiceAccent.toLowerCase() === c.toLowerCase() ? 'border-white' : 'border-transparent'}`}
                    style={{ background: c }} title={c} />
                ))}
                <input type="color" value={form.invoiceAccent} onChange={(e) => set('invoiceAccent', e.target.value)}
                  className="h-7 w-10 cursor-pointer rounded border border-slate-700 bg-transparent" title="Custom colour" />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Used on this business's quotes and invoices, and it skins all of Klippy while you are working in {business.name}.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {([['fontDisplay', 'display', 'Headings'], ['fontBody', 'body', 'Body text']] as const).map(([key, role, lbl]) => (
                <div key={key}>
                  <label className={label}>{lbl}</label>
                  <select className={field} value={form[key]}
                    onChange={(e) => { set(key, e.target.value); loadFont(e.target.value); }}>
                    <option value="">Klippy default</option>
                    {fontsFor(role).map((f) => <option key={f.family} value={f.family}>{f.family}</option>)}
                  </select>
                  {form[key] && (
                    <p className="mt-1.5 truncate text-lg text-slate-200" style={{ fontFamily: `"${form[key]}"` }}>
                      {business.brandName || business.name}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">
              Fonts come from Google Fonts. They apply to Klippy while you work in this business, and to its invoices.
            </p>
          </section>}

          {/* Email */}
          {show('email') && <EmailSection businessId={business.id} businessName={business.name} />}

          {/* Access */}
          {show('access') && <AccessSection businessId={business.id} businessName={business.name} />}

          {/* Invoicing */}
          {show('invoicing') && <section className="space-y-4 border-t border-slate-800 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Invoicing details</h3>
            <div>
              <label className={label}>Currency</label>
              <select className={field} value={form.currency} onChange={(e) => set('currency', e.target.value)}>
                <option value="">Use the workspace currency ({workspaceCurrency})</option>
                {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} - {c.name}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                What this business bills in. Set it only if this business bills in something
                other than the workspace currency. Quotes and invoices already issued keep the
                currency they were raised in.
                {form.currency && form.currency !== 'ZAR' && (
                  <span className="mt-1 block text-amber-400/90">
                    PayFast settles rand only, so invoices in {form.currency} will not offer a
                    Pay online button. They still carry your bank details for a transfer.
                  </span>
                )}
              </p>
            </div>
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

            <NumberingEditor businessId={business.id} form={form} set={set} field={field} label={label} />

            <TemplateEditor
              header={form.invoiceHeaderHtml} footer={form.invoiceFooterHtml}
              onHeader={(v) => set('invoiceHeaderHtml', v)} onFooter={(v) => set('invoiceFooterHtml', v)} />
          </section>}

          {/* Payment reminders */}
          {show('reminders') && <section className="space-y-4 border-t border-slate-800 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Payment reminders</h3>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={form.remindersEnabled}
                onChange={(e) => set('remindersEnabled', e.target.checked)} />
              Automatically chase unpaid invoices for this business
            </label>
            <div>
              <label className={label}>Send reminders on these days (relative to the due date)</label>
              <input className={field} value={form.reminderOffsets} onChange={(e) => set('reminderOffsets', e.target.value)}
                placeholder="-3, 0, 7" />
              <p className="mt-1 text-[11px] text-slate-500">
                Negative is before due, 0 is on the due date, positive is overdue. Default: 3 days before, on the day, and a week after.
              </p>
            </div>
            <div>
              <label className={label}>Flag as at-risk after (days overdue)</label>
              <input type="number" min={0} max={365} className={field} value={form.suspendAfterDays}
                onChange={(e) => set('suspendAfterDays', e.target.value)} placeholder="Leave blank to never flag" />
              <p className="mt-1 text-[11px] text-slate-500">
                Once this overdue, a final "service at risk" notice is sent and the invoice shows in Collections as flagged. Klippy notifies, it does not cut off service.
              </p>
            </div>
          </section>}
      </div>

      {showSave && (
        <div className="mt-5 flex items-center gap-3 border-t border-slate-800 pt-4">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-60">
            {save.isPending ? 'Saving...' : 'Save'}
          </button>
          {saved && <span className="text-sm text-violet-300">Saved</span>}
          {save.error && <span className="text-sm text-red-400">{(save.error as Error).message}</span>}
        </div>
      )}
    </>
  );
}

interface EmailCfg {
  fromName: string; fromEmail: string; replyTo: string;
  invoiceFromName: string; invoiceFromEmail: string; invoiceReplyTo: string;
  smtpHost: string; smtpPort: number | null; smtpSecure: boolean; smtpUser: string; hasSmtpPass: boolean;
}

/**
 * How this business addresses its email, and an optional own SMTP server. Blank
 * fields fall back to the business brand over the shared sending address, which is
 * shown so it is clear what a client will see when nothing is set.
 */
function EmailSection({ businessId, businessName }: { businessId: number; businessName: string }) {
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['business-email', businessId],
    queryFn: () => apiGet<{ email: EmailCfg; globalFrom: string | null; secretsReady: boolean }>(`/businesses/${businessId}/email`),
    retry: false,
  });
  const [form, setForm] = useState<Record<string, string | boolean | number | null>>({});
  const [smtpPass, setSmtpPass] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data && Object.keys(form).length === 0) {
      const e = data.email;
      setForm({ ...e });
      if (e.smtpHost) setShowAdvanced(true);
    }
  }, [data, form]);

  const save = useMutation({
    mutationFn: () => apiPatch(`/businesses/${businessId}/email`, {
      ...form,
      ...(smtpPass ? { smtpPass } : {}),
    }),
    onSuccess: () => { setSmtpPass(''); setSaved(true); setTimeout(() => setSaved(false), 2000); qc.invalidateQueries({ queryKey: ['business-email', businessId] }); },
  });

  if (error) return null; // not an admin of this business
  if (!data) return null;
  const set = (k: string, v: string | boolean | number | null) => setForm((f) => ({ ...f, [k]: v }));
  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]';
  const label = 'mb-1 block text-[11px] font-medium text-slate-400';
  const s = (k: string) => (form[k] as string) ?? '';

  return (
    <section className="space-y-4 border-t border-slate-800 pt-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email</h3>
        <p className="mt-1 text-[11px] text-slate-500">
          What clients see this business's mail come from. Blank uses
          {' '}<span className="text-slate-400">{businessName}</span>{' '}
          over {data.globalFrom ? <span className="text-slate-400">{data.globalFrom}</span> : 'the shared address'}.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={label}>From name</label>
          <input className={field} value={s('fromName')} onChange={(e) => set('fromName', e.target.value)} placeholder={businessName} /></div>
        <div><label className={label}>From email</label>
          <input className={field} value={s('fromEmail')} onChange={(e) => set('fromEmail', e.target.value)} placeholder="hello@yourdomain.com" /></div>
      </div>
      <div><label className={label}>Reply-to (optional)</label>
        <input className={field} value={s('replyTo')} onChange={(e) => set('replyTo', e.target.value)} placeholder="you@yourdomain.com" /></div>

      <div className="rounded-lg border border-slate-800 p-3">
        <p className="mb-2 text-[11px] font-medium text-slate-400">Invoices, quotes and reminders (optional, overrides the above)</p>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>From name</label>
            <input className={field} value={s('invoiceFromName')} onChange={(e) => set('invoiceFromName', e.target.value)} placeholder="e.g. Billing" /></div>
          <div><label className={label}>From email</label>
            <input className={field} value={s('invoiceFromEmail')} onChange={(e) => set('invoiceFromEmail', e.target.value)} placeholder="billing@yourdomain.com" /></div>
        </div>
      </div>

      <button onClick={() => setShowAdvanced((v) => !v)} className="text-[11px] text-slate-500 underline decoration-dotted hover:text-slate-300">
        {showAdvanced ? 'Hide' : 'Use'} this business's own mail server (advanced)
      </button>
      {showAdvanced && (
        <div className="space-y-3 rounded-lg border border-slate-800 p-3">
          <p className="text-[11px] text-slate-500">
            Only if this business has its own authenticated mail domain. Otherwise leave blank and mail goes through the shared server.
          </p>
          {!data.secretsReady && <p className="text-[11px] text-red-400">Server needs PAYMENTS_SECRET set before a password can be stored.</p>}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>SMTP host</label>
              <input className={field} value={s('smtpHost')} onChange={(e) => set('smtpHost', e.target.value)} placeholder="mail.yourdomain.com" /></div>
            <div><label className={label}>Port</label>
              <input type="number" className={field} value={(form.smtpPort as number) ?? ''} onChange={(e) => set('smtpPort', e.target.value === '' ? null : Number(e.target.value))} placeholder="587" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Username</label>
              <input className={field} value={s('smtpUser')} onChange={(e) => set('smtpUser', e.target.value)} placeholder="billing@yourdomain.com" /></div>
            <div><label className={label}>Password</label>
              <input type="password" className={field} value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder={data.email.hasSmtpPass ? 'Set. Leave blank to keep.' : ''} /></div>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={!!form.smtpSecure} onChange={(e) => set('smtpSecure', e.target.checked)} />
            Use TLS (port 465)
          </label>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-60">
          {save.isPending ? 'Saving...' : 'Save email settings'}
        </button>
        {saved && <span className="text-[11px] text-violet-300">Saved</span>}
        {save.error && <span className="text-[11px] text-red-400">{(save.error as Error).message}</span>}
      </div>
    </section>
  );
}

interface AccessMember {
  userId: number; name: string; email: string; accountAdmin: boolean;
  role: 'admin' | 'member' | 'viewer' | null;
}

/**
 * Who can work in this business, and at what level. Account admins are shown as
 * full-access and cannot be scoped (they run the whole account). Everyone else is
 * granted per business: no access, viewer, member, or admin.
 */
function AccessSection({ businessId, businessName }: { businessId: number; businessName: string }) {
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['business-members', businessId],
    queryFn: () => apiGet<{ members: AccessMember[] }>(`/businesses/${businessId}/members`),
    retry: false,
  });
  const setRole = useMutation({
    mutationFn: (v: { userId: number; role: string }) =>
      v.role === 'none'
        ? apiDelete(`/businesses/${businessId}/members/${v.userId}`)
        : apiPut(`/businesses/${businessId}/members/${v.userId}`, { role: v.role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['business-members', businessId] }),
  });

  // Only shown when the current user can manage this business; the API 403s otherwise.
  if (error) return null;
  const others = (data?.members ?? []).filter((m) => !m.accountAdmin);

  return (
    <section className="space-y-3 border-t border-slate-800 pt-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Who can access {businessName}</h3>
        <p className="mt-1 text-[11px] text-slate-500">Account admins can see every business. Set access for everyone else here.</p>
      </div>
      {others.length === 0 && <p className="text-xs text-slate-500">No other people in this account yet. Add them under Settings &gt; People.</p>}
      <div className="space-y-1.5">
        {others.map((m) => (
          <div key={m.userId} className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-slate-200">{m.name}</div>
              <div className="truncate text-[11px] text-slate-500">{m.email}</div>
            </div>
            <select value={m.role ?? 'none'} onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value })}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none">
              <option value="none">No access</option>
              <option value="viewer">Viewer</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Edit the custom blocks on this business's documents.
 *
 * Deliberately a restricted subset rather than free HTML: whatever goes here has
 * to render identically on screen AND in the PDF the client actually receives, and
 * pdfkit cannot draw arbitrary markup. Anything outside the subset is dropped when
 * it saves, which is also what stops one person's template running as script in
 * everyone else's browser.
 */
function TemplateEditor({ header, footer, onHeader, onFooter }: {
  header: string; footer: string;
  onHeader: (v: string) => void; onFooter: (v: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['template-placeholders'],
    queryFn: () => apiGet<{ placeholders: { key: string; label: string }[] }>('/template-placeholders'),
    staleTime: 60 * 60 * 1000,
  });
  const [open, setOpen] = useState(!!header || !!footer);
  const area = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 font-mono text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)] min-h-[90px] resize-y';

  return (
    <div className="border-t border-slate-800 pt-4">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-slate-500 underline decoration-dotted hover:text-slate-300">
        {open ? 'Hide' : 'Customise'} what appears on this business's invoices
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <p className="text-[11px] text-slate-500">
            These blocks appear above the line items and below the totals, on both the invoice
            on screen and the PDF your client receives. Allowed:{' '}
            <code className="text-slate-400">p, strong, em, u, h1 h2 h3, ul ol li, a, br, hr</code>.
            Anything else is removed when you save.
          </p>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Header block</label>
            <textarea className={area} value={header} onChange={(e) => onHeader(e.target.value)}
              placeholder={'<p>Thank you for your business, {{client.name}}.</p>'} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Footer block</label>
            <textarea className={area} value={footer} onChange={(e) => onFooter(e.target.value)}
              placeholder={'<h3>Terms</h3><ul><li>Payment within 7 days</li><li>EFT only</li></ul>'} />
          </div>

          {data && (
            <div>
              <div className="mb-1.5 text-[11px] text-slate-500">
                Click to copy a placeholder. It is replaced with the real value on each document.
              </div>
              <div className="flex flex-wrap gap-1.5">
                {data.placeholders.map((p) => (
                  <button type="button" key={p.key} title={p.label}
                    onClick={() => navigator.clipboard?.writeText(`{{${p.key}}}`)}
                    className="rounded-full border border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200">
                    {`{{${p.key}}}`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Document numbering: the prefix and where the count is.
 *
 * Both matter when moving from another system. A lot of businesses have used the
 * same prefix for years and their clients recognise it, and starting again at 0001
 * next to invoices already numbered 1042 is a bookkeeping mess. The panel shows
 * what the next number will actually be, so neither setting is a guess.
 */
function NumberingEditor({ businessId, form, set, field, label }: {
  businessId: number;
  // The parent's form holds mixed types; this panel only reads its string fields.
  form: Record<string, unknown>;
  set: (k: never, v: never) => void;
  field: string; label: string;
}) {
  const { data } = useQuery({
    queryKey: ['numbering', businessId],
    queryFn: () => apiGet<{
      numbering: Record<string, { prefix: string; nextNumber: string; highestUsed: number }>;
    }>(`/businesses/${businessId}/numbering`),
  });

  const rows = [
    { key: 'invoice', name: 'Invoices', prefixKey: 'prefixInvoice', startKey: 'seqStartInvoice', fallback: 'INV-' },
    { key: 'quote', name: 'Quotes', prefixKey: 'prefixQuote', startKey: 'seqStartQuote', fallback: 'QUO-' },
    { key: 'credit_note', name: 'Credit notes', prefixKey: 'prefixCreditNote', startKey: 'seqStartCreditNote', fallback: 'CN-' },
  ];

  return (
    <div className="space-y-3 border-t border-slate-800 pt-4">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Numbering</h4>
        <p className="mt-0.5 text-[11px] text-slate-500">
          Your own prefix, and where the count starts. A start only ever moves the count forward:
          it can never reuse a number a document already has.
        </p>
      </div>

      <div className="space-y-2">
        {rows.map((r) => {
          const state = data?.numbering[r.key];
          return (
            <div key={r.key} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <span className="text-sm text-slate-200">{r.name}</span>
                {state && (
                  <span className="text-[11px] text-slate-500">
                    next: <span className="num text-[var(--accent)]">{state.nextNumber}</span>
                    {state.highestUsed > 0 && <>, highest used {state.highestUsed}</>}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Prefix</label>
                  <input className={field} placeholder={r.fallback}
                    value={String(form[r.prefixKey] ?? '')}
                    onChange={(e) => set(r.prefixKey as never, e.target.value as never)} />
                </div>
                <div>
                  <label className={label}>Start at</label>
                  <input type="number" min={1} className={field} placeholder="1"
                    value={String(form[r.startKey] ?? '')}
                    onChange={(e) => set(r.startKey as never, e.target.value as never)} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-500">Save to apply. The next number updates when you reopen this page.</p>
    </div>
  );
}

/**
 * Says why a logo is not showing.
 *
 * "The logo does not pull through" has three different causes that look identical:
 * none uploaded, the file is gone from the server, or it is there but unreadable.
 * Only the middle one needs explaining, because it is not the user's fault and the
 * fix is not obvious: uploads kept inside the deployed folder get wiped whenever
 * the app is deployed.
 */
function LogoStatus({ businessId, bust }: { businessId: number; bust: number }) {
  const { data } = useQuery({
    queryKey: ['logo-status', businessId, bust],
    queryFn: () => apiGet<{ set: boolean; ok: boolean; missing?: boolean; reason: string; width?: number; height?: number }>(
      `/businesses/${businessId}/logo-status`),
    retry: false,
  });
  if (!data || !data.set) return null;
  if (data.ok) {
    return (
      <p className="text-[11px] text-slate-500">
        Logo is {data.width} by {data.height} pixels and renders on documents.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="text-xs font-medium text-amber-300">This logo will not appear on documents</div>
      <p className="mt-1 text-[11px] text-amber-200/80">{data.reason}</p>
    </div>
  );
}
