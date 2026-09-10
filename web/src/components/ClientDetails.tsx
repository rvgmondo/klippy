import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Save, Building2, Wallet, Handshake, ExternalLink } from 'lucide-react';
import { apiGet, apiPatch } from '../lib/api';
import { Modal } from './Modal';
import { fieldClass, btnPrimary, btnSecondary } from './ui';
import { notify } from './ConfirmDialog';
import type { Folder } from '../lib/types';

/**
 * Everything Klippy knows about one client, in one place.
 *
 * This exists because the answers used to be spread across eight menu items, each
 * one a prompt box holding a single value. That is fine for two fields and absurd
 * for twenty, and it meant nowhere in the app could answer "who are these people",
 * which is the question asked the afternoon a contract has to go out.
 *
 * NOTHING HERE IS REQUIRED. A one-person client with no registration number is a
 * normal client, and a form that will not save without one is a form nobody fills
 * in. The point is a place to put what you know, not a gate.
 *
 * Country comes first in the legal section on purpose: it decides what the fields
 * under it are even called. A registration number is a CIPC number in South
 * Africa, a Companies House number in the UK and an EIN in the US, and a form that
 * says "Registration number" to all three is a form people fill in wrongly.
 */

interface Contact { id: number; name: string; email: string | null; role: string | null; folderId: number | null }
interface Member { id: number; name: string | null; email: string }

/** Enough of the world to be useful, with the ones Klippy actually serves first. */
const COUNTRIES: { code: string; name: string }[] = [
  { code: 'ZA', name: 'South Africa' },
  { code: 'NA', name: 'Namibia' }, { code: 'BW', name: 'Botswana' },
  { code: 'ZW', name: 'Zimbabwe' }, { code: 'MZ', name: 'Mozambique' },
  { code: 'GB', name: 'United Kingdom' }, { code: 'IE', name: 'Ireland' },
  { code: 'US', name: 'United States' }, { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' }, { code: 'NZ', name: 'New Zealand' },
  { code: 'NL', name: 'Netherlands' }, { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' }, { code: 'AE', name: 'United Arab Emirates' },
];

/**
 * What the registration number is called where the client is registered, and what
 * legal forms exist there. Falling back to the generic wording is deliberate: a
 * country not on this list still works, it just gets plainer labels.
 */
const BY_COUNTRY: Record<string, { regLabel: string; regHint: string; types: string[] }> = {
  ZA: {
    regLabel: 'CIPC registration number', regHint: '2019/123456/07',
    types: ['Pty Ltd', 'Close Corporation', 'Sole Proprietor', 'Trust', 'Public Company', 'Non-profit', 'Partnership'],
  },
  GB: {
    regLabel: 'Companies House number', regHint: '12345678',
    types: ['Ltd', 'PLC', 'LLP', 'Sole Trader', 'Partnership', 'CIC', 'Charity'],
  },
  US: {
    regLabel: 'EIN', regHint: '12-3456789',
    types: ['LLC', 'Inc', 'S Corp', 'C Corp', 'Sole Proprietor', 'Partnership', 'Non-profit'],
  },
  AU: {
    regLabel: 'ABN', regHint: '12 345 678 901',
    types: ['Pty Ltd', 'Sole Trader', 'Partnership', 'Trust', 'Public Company'],
  },
};
const GENERIC = {
  regLabel: 'Registration number', regHint: 'As it appears on the certificate',
  types: ['Private company', 'Public company', 'Sole proprietor', 'Partnership', 'Trust', 'Non-profit'],
};

const INDUSTRIES = [
  'Accounting', 'Advertising', 'Agriculture', 'Architecture', 'Automotive', 'Construction',
  'Consulting', 'Education', 'Energy', 'Engineering', 'Entertainment', 'Fashion', 'Financial services',
  'Fitness', 'Food and drink', 'Government', 'Healthcare', 'Hospitality', 'Insurance', 'Legal',
  'Logistics', 'Manufacturing', 'Media', 'Mining', 'Non-profit', 'Property', 'Recruitment', 'Retail',
  'Security', 'Software', 'Sport', 'Telecommunications', 'Tourism', 'Transport', 'Wholesale',
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const LAST_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

type Draft = Record<string, string>;

/** Every field this screen edits, as strings, because that is what inputs hold. */
const FIELDS = [
  'legalName', 'regNumber', 'companyType', 'country', 'taxNumber', 'industry', 'website',
  'bbbeeLevel', 'financialYearEnd', 'paymentTermsDays', 'creditLimit', 'currency',
  'clientStatus', 'clientSince', 'accountManagerId', 'source', 'primaryContactId',
  'billingEmail', 'billingPhone', 'billingVatNumber', 'billingAddress',
  'hourlyRate', 'monthlyHoursBudget',
] as const;

export function ClientDetails({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'company' | 'money' | 'relationship'>('company');
  const [draft, setDraft] = useState<Draft>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const d: Draft = {};
    for (const f of FIELDS) {
      const v = (folder as unknown as Record<string, unknown>)[f];
      d[f] = v === null || v === undefined ? '' : String(v);
    }
    setDraft(d);
    setDirty(false);
  }, [folder]);

  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: () => apiGet<{ contacts: Contact[] }>('/contacts'),
  });
  const members = useQuery({
    queryKey: ['users'],
    queryFn: () => apiGet<{ users: Member[] }>('/users'),
  });

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const f of FIELDS) {
        const v = (draft[f] ?? '').trim();
        // Numbers go as numbers or null. An empty box means clear it, and the
        // server turns '' into null for the text fields for the same reason.
        if (f === 'paymentTermsDays' || f === 'accountManagerId' || f === 'primaryContactId') {
          body[f] = v === '' ? null : Number(v);
        } else if (f === 'creditLimit' || f === 'hourlyRate' || f === 'monthlyHoursBudget') {
          body[f] = v === '' ? null : Number(v);
        } else if (f === 'clientStatus') {
          body[f] = v || 'active';
        } else {
          body[f] = v === '' ? null : v;
        }
      }
      return apiPatch(`/folders/${folder.id}`, body);
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['contacts'] });
      notify('Saved.', 'ok');
    },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const set = (k: string, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setDirty(true); };
  const local = BY_COUNTRY[draft.country ?? ''] ?? GENERIC;

  // MM-DD split into two pickers, because nobody thinks in MM-DD.
  const feMonth = draft.financialYearEnd ? Number(draft.financialYearEnd.slice(0, 2)) : 0;
  const feDay = draft.financialYearEnd ? Number(draft.financialYearEnd.slice(3, 5)) : 0;
  const setYearEnd = (m: number, d: number) => {
    if (!m) return set('financialYearEnd', '');
    const capped = Math.min(d || LAST_DAY[m - 1]!, LAST_DAY[m - 1]!);
    set('financialYearEnd', `${String(m).padStart(2, '0')}-${String(capped).padStart(2, '0')}`);
  };

  const forThisClient = (contacts.data?.contacts ?? [])
    .filter((c) => c.folderId === folder.id || c.folderId === null);

  return (
    <Modal onClose={onClose} variant="drawer">
      <div className="flex h-full flex-col">
        <div className="flex items-start gap-3 border-b border-slate-800 p-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-slate-100">{folder.name}</h2>
            <p className="text-[11px] text-slate-500">
              {draft.legalName ? draft.legalName : 'Nothing here is required. Fill in what you know.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300">
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-slate-800 px-3 py-2">
          {([
            ['company', 'Company', Building2],
            ['money', 'Money', Wallet],
            ['relationship', 'Relationship', Handshake],
          ] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition ${
                tab === k ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-800/50'}`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {tab === 'company' && (
            <>
              {/* Country first: it decides what everything under it is called. */}
              <Field label="Country of registration"
                hint="Sets what the fields below are called and which legal forms are offered.">
                <select className={fieldClass} value={draft.country ?? ''}
                  onChange={(e) => set('country', e.target.value)}>
                  <option value="">Not set</option>
                  {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
              </Field>

              <Field label="Registered name"
                hint="Only when it differs from the name above. A tax invoice needs this one; every screen still shows the name you call them.">
                <input className={fieldClass} value={draft.legalName ?? ''}
                  onChange={(e) => set('legalName', e.target.value)}
                  placeholder="Sunrise Hospitality Group (Pty) Ltd" />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={local.regLabel}>
                  <input className={fieldClass} value={draft.regNumber ?? ''}
                    onChange={(e) => set('regNumber', e.target.value)} placeholder={local.regHint} />
                </Field>
                <Field label="Legal form">
                  <input className={fieldClass} list="klippy-company-types" value={draft.companyType ?? ''}
                    onChange={(e) => set('companyType', e.target.value)} placeholder={local.types[0]} />
                  <datalist id="klippy-company-types">
                    {local.types.map((t) => <option key={t} value={t} />)}
                  </datalist>
                </Field>
                <Field label="VAT number">
                  <input className={fieldClass} value={draft.billingVatNumber ?? ''}
                    onChange={(e) => set('billingVatNumber', e.target.value)} placeholder="4123456789" />
                </Field>
                <Field label="Income tax number" hint="Not the same number as VAT.">
                  <input className={fieldClass} value={draft.taxNumber ?? ''}
                    onChange={(e) => set('taxNumber', e.target.value)} />
                </Field>
                <Field label="Industry">
                  <input className={fieldClass} list="klippy-industries" value={draft.industry ?? ''}
                    onChange={(e) => set('industry', e.target.value)} placeholder="Food and drink" />
                  <datalist id="klippy-industries">
                    {INDUSTRIES.map((t) => <option key={t} value={t} />)}
                  </datalist>
                </Field>
                <Field label="Website">
                  <div className="flex gap-1.5">
                    <input className={fieldClass} value={draft.website ?? ''}
                      onChange={(e) => set('website', e.target.value)} placeholder="acme.co.za" />
                    {folder.website && (
                      <a href={folder.website} target="_blank" rel="noreferrer" title="Open"
                        className="grid w-9 shrink-0 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200">
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                </Field>
              </div>

              {/* Only where it means anything. Everywhere else it is noise. */}
              {draft.country === 'ZA' && (
                <Field label="B-BBEE level"
                  hint="Asked for when you invoice a corporate, and otherwise lives on a certificate nobody can find.">
                  <select className={fieldClass} value={draft.bbbeeLevel ?? ''}
                    onChange={(e) => set('bbbeeLevel', e.target.value)}>
                    <option value="">Not set</option>
                    {['1', '2', '3', '4', '5', '6', '7', '8', 'Non-compliant', 'Exempt (EME)'].map((l) => (
                      <option key={l} value={l}>{/^\d$/.test(l) ? `Level ${l}` : l}</option>
                    ))}
                  </select>
                </Field>
              )}

              <Field label="Registered address">
                <textarea className={fieldClass + ' resize-y'} rows={3} value={draft.billingAddress ?? ''}
                  onChange={(e) => set('billingAddress', e.target.value)} />
              </Field>
            </>
          )}

          {tab === 'money' && (
            <>
              <Field label="Financial year end"
                hint="Their year, not yours. What a year-end request or an annual report is timed against.">
                <div className="flex gap-2">
                  <select className={fieldClass} value={feMonth || ''}
                    onChange={(e) => setYearEnd(Number(e.target.value), feDay)}>
                    <option value="">Not set</option>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                  <select className={fieldClass} value={feDay || ''} disabled={!feMonth}
                    onChange={(e) => setYearEnd(feMonth, Number(e.target.value))}>
                    {Array.from({ length: feMonth ? LAST_DAY[feMonth - 1]! : 0 }, (_, i) => i + 1)
                      .map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Payment terms"
                  hint="Blank uses the business default. Zero means on receipt, which is not the same thing.">
                  <div className="flex items-center gap-2">
                    <input className={fieldClass} type="number" min={0} max={365}
                      value={draft.paymentTermsDays ?? ''}
                      onChange={(e) => set('paymentTermsDays', e.target.value)} placeholder="Business default" />
                    <span className="shrink-0 text-xs text-slate-500">days</span>
                  </div>
                </Field>
                <Field label="Invoice currency" hint="Only when it is not the business currency. Klippy never converts.">
                  <input className={fieldClass} maxLength={3} value={draft.currency ?? ''}
                    onChange={(e) => set('currency', e.target.value.toUpperCase())} placeholder="ZAR" />
                </Field>
                <Field label="Credit limit" hint="Informational. Nothing is blocked by it.">
                  <input className={fieldClass} type="number" min={0} step="0.01" value={draft.creditLimit ?? ''}
                    onChange={(e) => set('creditLimit', e.target.value)} />
                </Field>
                <Field label="Hourly rate" hint="What work logged under this client bills at.">
                  <input className={fieldClass} type="number" min={0} step="0.01" value={draft.hourlyRate ?? ''}
                    onChange={(e) => set('hourlyRate', e.target.value)} />
                </Field>
                <Field label="Retainer hours a month" hint="Reports compare tracked hours against it.">
                  <input className={fieldClass} type="number" min={0} step="0.5" value={draft.monthlyHoursBudget ?? ''}
                    onChange={(e) => set('monthlyHoursBudget', e.target.value)} />
                </Field>
                <Field label="Billing email" hint="Where invoices and payment reminders go.">
                  <input className={fieldClass} type="email" value={draft.billingEmail ?? ''}
                    onChange={(e) => set('billingEmail', e.target.value)} placeholder="accounts@acme.co.za" />
                </Field>
                <Field label="Billing phone" hint="The number WhatsApp and SMS reminders go to.">
                  <input className={fieldClass} value={draft.billingPhone ?? ''}
                    onChange={(e) => set('billingPhone', e.target.value)} />
                </Field>
              </div>
            </>
          )}

          {tab === 'relationship' && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Status">
                  <select className={fieldClass} value={draft.clientStatus || 'active'}
                    onChange={(e) => set('clientStatus', e.target.value)}>
                    <option value="prospect">Prospect, not a client yet</option>
                    <option value="active">Active</option>
                    <option value="dormant">Dormant, quiet for now</option>
                    <option value="former">Former, no longer a client</option>
                  </select>
                </Field>
                <Field label="Client since">
                  <input className={fieldClass} type="date" value={draft.clientSince ?? ''}
                    onChange={(e) => set('clientSince', e.target.value)} />
                </Field>
              </div>

              <Field label="Authorised contact"
                hint="The person who can sign things off for this company. Picked from your contacts, so there is one record of them rather than a copy here.">
                <select className={fieldClass} value={draft.primaryContactId ?? ''}
                  onChange={(e) => set('primaryContactId', e.target.value)}>
                  <option value="">Not set</option>
                  {forThisClient.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.role ? `, ${c.role}` : ''}{c.email ? ` (${c.email})` : ''}
                    </option>
                  ))}
                </select>
                {!forThisClient.length && (
                  <p className="mt-1 text-[11px] text-amber-300">
                    No contacts yet. Add one under Sales, Contacts, and it will appear here.
                  </p>
                )}
              </Field>

              <Field label="Who looks after them" hint="The person here who owns this relationship.">
                <select className={fieldClass} value={draft.accountManagerId ?? ''}
                  onChange={(e) => set('accountManagerId', e.target.value)}>
                  <option value="">Not set</option>
                  {(members.data?.users ?? []).map((u) => (
                    <option key={u.id} value={u.id}>{u.name || u.email}</option>
                  ))}
                </select>
              </Field>

              <Field label="How they found you" hint="The only field here that ever tells you where to spend.">
                <input className={fieldClass} list="klippy-sources" value={draft.source ?? ''}
                  onChange={(e) => set('source', e.target.value)} placeholder="Referral from ..." />
                <datalist id="klippy-sources">
                  {['Referral', 'Word of mouth', 'Google', 'Instagram', 'Facebook', 'LinkedIn',
                    'Cold outreach', 'Existing client', 'Event', 'Directory'].map((t) => <option key={t} value={t} />)}
                </datalist>
              </Field>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-slate-800 p-4">
          <button onClick={onClose} className={btnSecondary}>Close</button>
          <div className="flex-1" />
          {dirty && <span className="text-[11px] text-amber-300">Unsaved</span>}
          <button onClick={() => save.mutate()} disabled={!dirty || save.isPending}
            className={btnPrimary + ' flex items-center gap-1.5'}>
            <Save size={14} /> {save.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}
