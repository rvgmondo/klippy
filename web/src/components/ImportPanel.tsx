import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, Check, X } from 'lucide-react';
import { apiPost, ApiError } from '../lib/api';
import { confirmDialog, notify } from './ConfirmDialog';
import type { Business } from '../lib/types';
import { money } from '../lib/money';
import { btnPrimary } from './ui';

/**
 * Bring clients over from Invoice Ninja.
 *
 * The person picks every CSV the export gave them at once; each file is
 * recognised by its columns, not its name, because downloads get renamed. The
 * server answers with a preview first: every client, and whether it will be added
 * new, joined to a client already in Klippy, or left out. Every one of those can
 * be changed here before anything is written, which is the point. The export is
 * messy and only the person knows that "Early Bird Co" is "Early Bird Coffee Co".
 */

type Row = Record<string, string>;
type Kind = 'clients' | 'contacts' | 'invoices' | 'quotes' | 'recurring' | 'payments';
type Choice = number | 'new' | 'skip';
interface PreviewClient {
  name: string; email: string | null; phone: string | null; people: number; junk: string | null;
  onlyInDocuments: boolean; documents: number; choice: Choice; matchedName: string | null;
}
interface Preview {
  business: string;
  existing: { id: number; name: string }[];
  clients: PreviewClient[];
  counts: {
    newClients: number; matchedClients: number; leftOut: number; people: number; invoices: number; quotes: number;
    alreadyImported: number; payments: number; repeating: number; unpaidInvoices: number; unpaidTotal: number;
  };
}
type Added = { clients: number; filled: number; people: number; invoices: number; quotes: number; payments: number; repeating: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const KIND_LABEL: Record<Kind, string> = {
  clients: 'Clients', contacts: 'Contacts', invoices: 'Invoices', quotes: 'Quotes', recurring: 'Recurring invoices', payments: 'Payments',
};

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

/** Which export a file is, from its columns. */
function kindOf(rows: Row[]): Kind | null {
  const cols = new Set(Object.keys(rows[0] ?? {}));
  if (cols.has('Recurring Invoice How Often') || cols.has('Recurring Invoice Amount')) return 'recurring';
  if (cols.has('Invoice Invoice Number')) return 'invoices';
  if (cols.has('Quote Number')) return 'quotes';
  if (cols.has('Payment Amount')) return 'payments';
  if (cols.has('Contact First Name') && cols.has('Client Name')) return 'contacts';
  if (cols.has('Name') && (cols.has('Client Phone') || cols.has('VAT Number'))) return 'clients';
  return null;
}


export function ImportPanel({ business }: { business: Business }) {
  const qc = useQueryClient();
  const [files, setFiles] = useState<Partial<Record<Kind, Row[]>>>({});
  const [skipped, setSkipped] = useState<string[]>([]);
  const [include, setInclude] = useState({ contacts: true, invoices: true, quotes: true, payments: true, recurring: false });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const [filter, setFilter] = useState<'all' | 'matched' | 'new' | 'skip'>('all');

  const ask = async (dryRun: boolean, nextChoices = choices, nextInclude = include, nextFiles = files) => {
    setBusy(true);
    try {
      const res = await apiPost<{ preview: Preview; done: boolean; added?: Added }>('/import/invoice-ninja', {
        businessId: business.id, dryRun, files: nextFiles, choices: nextChoices, include: nextInclude,
      });
      setPreview(res.preview);
      if (res.done && res.added) {
        setAdded(res.added);
        void qc.invalidateQueries();
        notify('Imported.', 'ok');
      }
    } catch (e) {
      notify(e instanceof ApiError ? e.message : 'The import did not run.', 'error');
    } finally { setBusy(false); }
  };

  const pick = async (list: FileList) => {
    const next: Partial<Record<Kind, Row[]>> = { ...files };
    const unknown: string[] = [];
    for (const f of Array.from(list)) {
      const rows = parseCsv(await f.text());
      const k = kindOf(rows);
      if (k) next[k] = rows; else unknown.push(f.name);
    }
    setFiles(next); setSkipped(unknown); setAdded(null);
    if (next.clients || next.contacts) void ask(true, choices, include, next);
  };

  const choose = (name: string, c: Choice) => {
    const next = { ...choices, [name]: c };
    setChoices(next);
    void ask(true, next);
  };
  const toggle = (k: keyof typeof include) => {
    const next = { ...include, [k]: !include[k] };
    if (k === 'invoices' && !next.invoices) next.payments = false;
    setInclude(next);
    if (preview) void ask(true, choices, next);
  };

  const run = async () => {
    if (!preview) return;
    const c = preview.counts;
    const ok = await confirmDialog(
      `Bring ${plural(c.newClients + c.matchedClients, 'client')} into ${preview.business}? ${c.newClients} new, and ${c.matchedClients} joined to clients you already have. Nothing is emailed to anyone, and running it again will not make doubles.`,
      { confirmLabel: 'Import' },
    );
    if (ok) await ask(false);
  };

  const shown = useMemo(() => (preview?.clients ?? []).filter((c) => filter === 'all'
    || (filter === 'matched' ? typeof c.choice === 'number' : c.choice === filter)), [preview, filter]);
  const loaded = (Object.keys(files) as Kind[]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-slate-100">Bring clients in from Invoice Ninja</h3>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          Export from Invoice Ninja, then choose all the CSV files here together. You will see every
          client before anything is saved, and you can say which ones are already in Klippy under
          another name. Clients you already have are never overwritten; only their empty details are filled in.
        </p>
      </div>

      <label className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-600 p-4 hover:bg-slate-800/50 ${busy ? 'opacity-60' : ''}`}>
        <Upload className="h-5 w-5 text-slate-400" />
        <span className="text-sm text-slate-300">
          {loaded.length ? 'Choose the files again' : 'Choose the CSV files'}
          <span className="block text-xs text-slate-500">clients.csv and contacts.csv matter most. Invoices, quotes and payments are optional.</span>
        </span>
        <input type="file" multiple accept=".csv,text/csv" className="hidden" disabled={busy}
          onChange={(e) => { const l = e.target.files; if (l?.length) void pick(l); e.target.value = ''; }} />
      </label>

      {(loaded.length > 0 || skipped.length > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <span key={k} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 ${files[k] ? 'border-emerald-500/40 text-emerald-300' : 'border-slate-700 text-slate-500'}`}>
              {files[k] ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
              {KIND_LABEL[k]}{files[k] ? ` (${files[k]!.length})` : ''}
            </span>
          ))}
          {skipped.length > 0 && <span className="text-amber-300">Not recognised: {skipped.join(', ')}</span>}
        </div>
      )}

      {preview && (
        <>
          <div className="rounded-xl border border-slate-700 p-4">
            <p className="text-sm font-medium text-slate-200">What else to bring</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {([
                ['contacts', 'The people at each client', !!(files.contacts || files.clients)],
                ['invoices', 'Old invoices, as history', !!files.invoices],
                ['quotes', 'Old quotes, as history', !!files.quotes],
                ['payments', 'Payments against those invoices', !!files.payments && include.invoices],
                ['recurring', 'Monthly billing, making drafts only', !!files.recurring],
              ] as const).map(([k, label, possible]) => (
                <label key={k} className={`flex items-center gap-2 text-sm ${possible ? 'text-slate-300' : 'text-slate-600'}`}>
                  <input type="checkbox" checked={include[k] && possible} disabled={!possible || busy} onChange={() => toggle(k)} />
                  {label}
                </label>
              ))}
            </div>
            {include.invoices && (
              <p className="mt-3 text-xs text-slate-500">
                Old invoices keep their old numbers and sit next to the ones you made in Klippy. Klippy's own
                numbering carries on where it is, and nothing old is ever chased automatically, so you can go
                through them and mark what was really paid. Use the Chase button yourself where it is still owed.
              </p>
            )}
            {include.recurring && (
              <p className="mt-2 text-xs text-slate-500">
                Each monthly invoice becomes a monthly bill on that client that makes drafts only, so you check
                each one before it goes out. Clients already billed monthly in Klippy are left alone.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['New clients', preview.counts.newClients],
              ['Joined to yours', preview.counts.matchedClients],
              ['People', preview.counts.people],
              ['Left out', preview.counts.leftOut],
              ...(include.invoices ? [['Old invoices', preview.counts.invoices] as const] : []),
              ...(include.quotes ? [['Old quotes', preview.counts.quotes] as const] : []),
              ...(include.payments ? [['Payments', preview.counts.payments] as const] : []),
              ...(include.invoices ? [['Still unpaid', preview.counts.unpaidInvoices ? `${preview.counts.unpaidInvoices}, ${money(preview.counts.unpaidTotal, business.currency ?? 'ZAR')}` : '0'] as const] : []),
            ].map(([label, n]) => (
              <div key={label} className="rounded-xl border border-slate-700 p-3">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="mt-0.5 text-lg font-semibold text-slate-100">{n}</p>
              </div>
            ))}
          </div>
          {preview.counts.alreadyImported > 0 && (
            <p className="text-xs text-slate-500">{preview.counts.alreadyImported} documents are already in Klippy from an earlier import and will be left as they are.</p>
          )}

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-200">Clients ({preview.clients.length})</p>
              <div className="flex gap-1 text-xs">
                {(['all', 'matched', 'new', 'skip'] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`rounded-lg px-2.5 py-1 ${filter === f ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:bg-slate-800'}`}>
                    {f === 'all' ? 'All' : f === 'matched' ? 'Joined to yours' : f === 'new' ? 'New' : 'Left out'}
                  </button>
                ))}
              </div>
            </div>
            <div className="divide-y divide-slate-800 rounded-xl border border-slate-700">
              {shown.map((c) => (
                <div key={c.name} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-200">{c.name}</p>
                    <p className="truncate text-xs text-slate-500">
                      {[c.email, c.phone, c.people ? plural(c.people, 'person', 'people') : null,
                        c.documents ? plural(c.documents, 'document') : null].filter(Boolean).join(', ') || 'No details'}
                      {c.onlyInDocuments ? '. Only on invoices, not in the clients file' : ''}
                    </p>
                    {c.junk && <p className="text-xs text-amber-300">{c.junk}</p>}
                  </div>
                  <select value={String(c.choice)} disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value;
                      choose(c.name, v === 'new' || v === 'skip' ? v : Number(v));
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 sm:w-64">
                    <option value="new">Add as a new client</option>
                    <option value="skip">Leave out</option>
                    <optgroup label="Same as a client you have">
                      {preview.existing.map((e) => <option key={e.id} value={e.id}>Same as {e.name}</option>)}
                    </optgroup>
                  </select>
                </div>
              ))}
              {shown.length === 0 && <p className="p-3 text-sm text-slate-500">Nothing here.</p>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => void run()} disabled={busy}
              className={btnPrimary}>
              {busy ? 'Working' : `Import into ${preview.business}`}
            </button>
            <p className="text-xs text-slate-500">Nothing is sent to your clients.</p>
          </div>
        </>
      )}

      {added && (
        <div className="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-quiet)] p-4 text-sm text-slate-200">
          <p className="font-medium">Done.</p>
          <p className="mt-1 text-slate-300">
            {[
              `${plural(added.clients, 'new client')}`,
              added.filled ? `${plural(added.filled, 'existing client')} filled in` : '',
              plural(added.people, 'person', 'people'),
              added.invoices ? plural(added.invoices, 'old invoice') : '',
              added.quotes ? plural(added.quotes, 'old quote') : '',
              added.payments ? plural(added.payments, 'payment') : '',
              added.repeating ? plural(added.repeating, 'monthly bill') : '',
            ].filter(Boolean).join(', ')}.
            {' '}Old invoices are in Money with their old numbers, oldest at the bottom.
          </p>
        </div>
      )}
    </div>
  );
}
