import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { apiGet, apiPatch } from '../lib/api';
import type { Business } from '../lib/types';

interface DesignInfo { key: string; label: string; blurb: string }
interface Designs { templates: DesignInfo[]; typefaces: DesignInfo[]; placements: DesignInfo[] }

/**
 * Choosing how this business's documents look.
 *
 * The preview is the point. This is the thing every client receives, so picking it
 * from a name and a sentence would be guessing; the panel renders a real sample
 * invoice in the business's own brand, logo and details, and updates as the choice
 * changes. Nothing is saved until Save, so trying designs costs nothing.
 */
export function PdfDesignPanel({ business }: { business: Business }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['pdf-designs'],
    queryFn: () => apiGet<Designs>('/pdf-designs'),
    staleTime: 60 * 60 * 1000,
  });

  const [template, setTemplate] = useState(business.pdfTemplate ?? 'modern');
  const [typeface, setTypeface] = useState(business.pdfTypeface ?? 'sans');
  const [issuer, setIssuer] = useState(business.pdfIssuerPlacement ?? 'footer');
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => apiPatch(`/businesses/${business.id}`, {
      pdfTemplate: template, pdfTypeface: typeface, pdfIssuerPlacement: issuer,
    }),
    onSuccess: () => {
      setSaved(true); setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ['businesses'] });
    },
  });

  // The preview URL carries the pending choice, so it shows what Save would do.
  const previewUrl = `/api/v1/businesses/${business.id}/pdf-preview?template=${template}&typeface=${typeface}&issuer=${issuer}`;
  // PDF open parameters. Without these the browser wraps the document in its own
  // viewer, and the toolbar plus the thumbnail rail eat enough width that the page
  // renders at about 60% in a corner, which is a poor way to judge a design.
  // FitH makes it fill the width instead. Ignored by viewers that do not support
  // them, so nothing breaks where they are not honoured.
  const embedUrl = `${previewUrl}#toolbar=0&navpanes=0&scrollbar=0&statusbar=0&view=FitH`;
  const dirty = template !== (business.pdfTemplate ?? 'modern')
    || typeface !== (business.pdfTypeface ?? 'sans')
    || issuer !== (business.pdfIssuerPlacement ?? 'footer');

  if (!data) return null;

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        How this business's invoices, quotes and credit notes look as a PDF. The preview uses your real
        brand colour, logo and details, so what you see is what your clients get.
      </p>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Design</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {data.templates.map((t) => (
            <button key={t.key} onClick={() => setTemplate(t.key)}
              className={`rounded-lg border p-3 text-left transition ${
                template === t.key ? 'border-[var(--accent)] bg-[var(--accent-quiet)]' : 'border-slate-700 hover:border-slate-600'}`}>
              <div className="text-sm font-medium text-slate-100">{t.label}</div>
              <div className="mt-0.5 text-[11px] text-slate-400">{t.blurb}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Typeface</div>
        <div className="grid gap-2 sm:grid-cols-3">
          {data.typefaces.map((t) => (
            <button key={t.key} onClick={() => setTypeface(t.key)}
              className={`rounded-lg border p-2.5 text-left transition ${
                typeface === t.key ? 'border-[var(--accent)] bg-[var(--accent-quiet)]' : 'border-slate-700 hover:border-slate-600'}`}>
              <div className="text-sm text-slate-100">{t.label}</div>
              <div className="mt-0.5 text-[10px] text-slate-400">{t.blurb}</div>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          A PDF can only use fonts it carries, so this is the print typeface rather than your web font.
          Serif reads more formal, mono lines figures up perfectly.
        </p>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Your address, registration and VAT number
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {data.placements.map((p) => (
            <button key={p.key} onClick={() => setIssuer(p.key)}
              className={`rounded-lg border p-2.5 text-left transition ${
                issuer === p.key ? 'border-[var(--accent)] bg-[var(--accent-quiet)]' : 'border-slate-700 hover:border-slate-600'}`}>
              <div className="text-sm text-slate-100">{p.label}</div>
              <div className="mt-0.5 text-[10px] text-slate-400">{p.blurb}</div>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          Classic and Sidebar always place these themselves, since it is part of what those designs are.
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Preview</div>
          <a href={previewUrl} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200">
            Open full size <ExternalLink size={11} />
          </a>
        </div>
        {/* Keyed so changing the design forces a reload rather than showing a cached page.
            White behind it, because the thing being judged is ink on paper. */}
        <object key={embedUrl} data={embedUrl} type="application/pdf"
          className="h-[620px] w-full rounded-lg border border-slate-700 bg-white">
          <div className="p-4 text-xs text-slate-600">
            Your browser will not show the PDF inline.{' '}
            <a href={previewUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
              Open the preview in a new tab
            </a>.
          </div>
        </object>
      </div>

      <div className="flex items-center gap-3 border-t border-slate-800 pt-4">
        <button onClick={() => save.mutate()} disabled={save.isPending || !dirty}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50">
          {save.isPending ? 'Saving...' : dirty ? 'Use this design' : 'Saved'}
        </button>
        {saved && <span className="text-sm text-violet-300">Saved</span>}
        {save.error && <span className="text-sm text-red-400">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}
