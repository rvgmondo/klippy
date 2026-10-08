import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Landmark, Upload } from 'lucide-react';
import { apiPost, ApiError } from '../lib/api';
import { money } from '../lib/money';
import { notify } from './ConfirmDialog';
import { Modal } from './Modal';
import { btnPrimary, btnSecondary } from './ui';

/**
 * Match a bank statement to open invoices.
 *
 * Every EFT used to be found and marked Paid by hand. Here the bank's own CSV is read,
 * each deposit gets a suggested invoice with the reason for the guess, and nothing is
 * recorded until the person has looked and pressed the button. Weak guesses (the
 * amount alone) and money that looks recorded already start unticked.
 */

type Confidence = 'number' | 'amount-and-name' | 'amount';
interface Row {
  line: number; date: string; description: string; amount: number;
  suggestion: { documentId: number; confidence: Confidence } | null;
  alreadyRecorded: string | null;
}
interface Open { id: number; number: string; clientName: string; outstanding: number; currency: string; imported: boolean }
interface Preview { rows: Row[]; open: Open[]; skipped: number }

const WHY: Record<Confidence, { label: string; tone: string }> = {
  number: { label: 'invoice number in the reference', tone: 'bg-emerald-500/15 text-emerald-300' },
  'amount-and-name': { label: 'amount and name match', tone: 'bg-emerald-500/10 text-emerald-200' },
  amount: { label: 'amount matches, check it', tone: 'bg-amber-500/15 text-amber-200' },
};

export function BankMatchModal({ businessId, onClose }: { businessId?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fileName, setFileName] = useState('');
  // Per deposit: which invoice it pays ('' for none), and whether to record it.
  const [pick, setPick] = useState<Record<number, string>>({});
  const [tick, setTick] = useState<Record<number, boolean>>({});
  const [onlyMatched, setOnlyMatched] = useState(true);

  const read = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 3 * 1024 * 1024) throw new Error('That file is over 3MB. Export a shorter period.');
      const csv = await file.text();
      return apiPost<Preview>('/bank-statement/preview', { csv, ...(businessId ? { businessId } : {}) });
    },
    onSuccess: (p) => {
      setPreview(p);
      const pk: Record<number, string> = {};
      const tk: Record<number, boolean> = {};
      for (const r of p.rows) {
        pk[r.line] = r.suggestion ? String(r.suggestion.documentId) : '';
        tk[r.line] = !!r.suggestion && r.suggestion.confidence !== 'amount' && !r.alreadyRecorded;
      }
      setPick(pk); setTick(tk);
    },
    onError: (e) => notify(e instanceof Error ? e.message : 'That file could not be read.', 'error'),
  });

  const openById = useMemo(() => new Map((preview?.open ?? []).map((o) => [o.id, o])), [preview]);
  const chosen = (preview?.rows ?? []).filter((r) => tick[r.line] && pick[r.line]);

  const apply = useMutation({
    mutationFn: () => apiPost<{ recorded: number; skipped: { number: string | null; reason: string }[] }>('/bank-statement/apply', {
      items: chosen.map((r) => ({ documentId: Number(pick[r.line]), amount: r.amount, paidOn: r.date, reference: r.description })),
    }),
    onSuccess: (res) => {
      for (const k of ['collections', 'documents', 'home', 'client', 'clients', 'cashflow', 'focus']) qc.invalidateQueries({ queryKey: [k] });
      const lead = `Recorded ${res.recorded} ${res.recorded === 1 ? 'payment' : 'payments'}.`;
      notify(res.skipped.length
        ? `${lead} ${res.skipped.length} skipped: ${res.skipped.slice(0, 3).map((s) => `${s.number ?? 'one'} (${s.reason.replace(/\.$/, '')})`).join(', ')}.`
        : lead, res.skipped.length ? 'error' : 'ok');
      onClose();
    },
    onError: (e) => notify(e instanceof ApiError ? e.message : 'Nothing was recorded.', 'error'),
  });

  const rows = (preview?.rows ?? []).filter((r) => !onlyMatched || pick[r.line]);
  const matched = (preview?.rows ?? []).filter((r) => pick[r.line]).length;

  return (
    <Modal onClose={onClose} variant="panel">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-700 bg-slate-950">
        <div className="border-b border-slate-800 p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100"><Landmark size={18} /> Match a bank statement</h2>
          <p className="mt-1 text-sm text-slate-400">
            Export the last few weeks from your online banking as a CSV file and choose it here. Klippy suggests which invoice
            each deposit pays. Nothing is recorded until you press the button.
          </p>
        </div>

        {!preview ? (
          <div className="p-5">
            <label className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-slate-700 p-8 text-center hover:bg-slate-900/50 ${read.isPending ? 'opacity-60' : ''}`}>
              <Upload size={22} className="text-slate-400" />
              <span className="text-sm text-slate-200">{read.isPending ? `Reading ${fileName}` : 'Choose the CSV file'}</span>
              <span className="text-xs text-slate-500">FNB, Standard Bank, Absa, Nedbank, Capitec and most others work.</span>
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" disabled={read.isPending}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFileName(f.name); read.mutate(f); } e.target.value = ''; }} />
            </label>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3 text-xs text-slate-400">
              <span>{preview.rows.length} deposits in {fileName}, {matched} matched to an invoice.</span>
              <label className="ml-auto inline-flex items-center gap-1.5">
                <input type="checkbox" checked={onlyMatched} onChange={(e) => setOnlyMatched(e.target.checked)} className="accent-violet-500" />
                Only show matched
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {rows.length === 0 && (
                <p className="p-6 text-center text-sm text-slate-500">
                  {preview.rows.length ? 'No deposit matched an open invoice. Untick "Only show matched" to pick them yourself.' : 'There is no money in on this statement.'}
                </p>
              )}
              {rows.map((r) => {
                const inv = pick[r.line] ? openById.get(Number(pick[r.line])) : undefined;
                const over = inv && r.amount > inv.outstanding + 0.01;
                const why = r.suggestion && String(r.suggestion.documentId) === pick[r.line] ? WHY[r.suggestion.confidence] : null;
                return (
                  <div key={r.line} className="flex flex-wrap items-start gap-3 border-b border-slate-800/70 px-5 py-3">
                    <input type="checkbox" checked={!!tick[r.line] && !!pick[r.line]} disabled={!pick[r.line]}
                      aria-label={`Record the deposit of ${money(r.amount, inv?.currency ?? 'ZAR')} on ${r.date}`}
                      onChange={(e) => setTick((t) => ({ ...t, [r.line]: e.target.checked }))} className="mt-1 accent-violet-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="num text-sm font-semibold text-slate-100">{money(r.amount, inv?.currency ?? 'ZAR')}</span>
                        <span className="num text-xs text-slate-500">{r.date}</span>
                      </div>
                      <div className="truncate text-xs text-slate-400" title={r.description}>{r.description || 'No reference'}</div>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                        {why && <span className={`rounded px-1.5 py-0.5 ${why.tone}`}>{why.label}</span>}
                        {r.alreadyRecorded && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200">looks recorded already on {r.alreadyRecorded}</span>}
                        {over && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">more than the {money(inv!.outstanding, inv!.currency)} it owes</span>}
                      </div>
                    </div>
                    <select value={pick[r.line] ?? ''} aria-label="Which invoice this pays"
                      onChange={(e) => { const v = e.target.value; setPick((p) => ({ ...p, [r.line]: v })); setTick((t) => ({ ...t, [r.line]: !!v })); }}
                      className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-200 sm:w-72 sm:min-h-9">
                      <option value="">Not an invoice payment</option>
                      {preview.open.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.number}, {o.clientName}, owes {money(o.outstanding, o.currency)}{o.imported ? ' (old system)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 p-4">
              <button onClick={() => setPreview(null)} className={btnSecondary}>Choose another file</button>
              <button onClick={() => apply.mutate()} disabled={!chosen.length || apply.isPending} className={btnPrimary}>
                {apply.isPending ? 'Recording' : `Record ${chosen.length} ${chosen.length === 1 ? 'payment' : 'payments'}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
