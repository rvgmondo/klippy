import { useQuery } from '@tanstack/react-query';
import { Download, Printer } from 'lucide-react';
import { apiGet } from '../lib/api';
import { Modal } from './Modal';
import { loadFont } from '../lib/fonts';
import { money, type FullDoc } from './billingShared';

export function PrintView({ id, onClose }: { id: number; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['document', id], queryFn: () => apiGet<FullDoc>(`/documents/${id}`) });
  if (!data) return null;
  const d = data.document;
  const cur = d.currency;

  const issuer = data.issuer;
  const accent = issuer.accent || '#6366f1';
  const isQuote = d.type === 'quote';
  // A VAT-registered business issues a "Tax Invoice" (the wording SARS requires).
  const label = isQuote ? 'Quotation' : issuer.vatRegistered ? 'Tax Invoice' : 'Invoice';
  const paid = d.status === 'paid';
  const discountAmt = Number(d.discountAmount ?? 0);
  loadFont(issuer.fontDisplay); loadFont(issuer.fontBody);

  return (
    <Modal onClose={onClose} variant="page">
      <div className="mx-auto my-4 max-w-3xl">
        <div className="no-print mb-3 flex justify-end gap-2">
          {/* The same PDF the client receives by email, rather than a browser print. */}
          <a href={`/api/v1/documents/${id}/pdf`} download
            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90">
            <Download size={15} /> Download PDF
          </a>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">
            <Printer size={15} /> Print
          </button>
          <button onClick={onClose} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Close</button>
        </div>

        {/* The document. Everything below reads on white so it prints cleanly, with a
            single accent colour the owner picks in Settings > Invoicing. */}
        {/* The business's own typefaces, so the printed invoice matches its brand. */}
        <div className="print-area overflow-hidden rounded-xl bg-white text-slate-900 shadow-xl"
          style={{
            fontFamily: issuer.fontBody ? `"${issuer.fontBody}", sans-serif` : undefined,
          }}>
          {/* Accent header band */}
          <div className="px-10 pb-7 pt-9" style={{ borderTop: `5px solid ${accent}` }}>
            <div className="flex items-start justify-between gap-6">
              <div className="flex items-center gap-3">
                {issuer.logoUrl && <img src={issuer.logoUrl} alt="" className="h-14 w-14 rounded-lg object-contain" />}
                <div>
                  <div className="text-xl font-bold leading-tight">{issuer.name}</div>
                  {issuer.address && <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-500">{issuer.address}</div>}
                  <div className="mt-1 space-x-3 text-[11px] text-slate-400">
                    {issuer.regNumber && <span>Reg {issuer.regNumber}</span>}
                    {issuer.taxNumber && <span>VAT {issuer.taxNumber}</span>}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold uppercase tracking-tight" style={{ color: accent }}>{label}</div>
                <div className="mt-1 num text-sm font-medium text-slate-500">{d.number}</div>
                {paid && (
                  <div className="mt-2 inline-block rounded-md border-2 px-2 py-0.5 text-xs font-bold uppercase tracking-wide"
                    style={{ color: accent, borderColor: accent }}>Paid</div>
                )}
              </div>
            </div>
          </div>

          <div className="px-10 pb-10">
            {/* Bill-to + dates */}
            <div className="mb-8 flex justify-between gap-6 text-sm">
              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: accent }}>Bill to</div>
                <div className="font-semibold text-slate-800">{d.clientName}</div>
                {d.clientEmail && <div className="text-slate-500">{d.clientEmail}</div>}
                {d.clientAddress && <div className="whitespace-pre-wrap text-slate-500">{d.clientAddress}</div>}
                {d.clientVatNumber && <div className="text-slate-500">VAT {d.clientVatNumber}</div>}
              </div>
              <div className="space-y-1 text-right">
                <div className="flex justify-between gap-6"><span className="text-slate-400">Issued</span><span className="num text-slate-700">{d.issueDate}</span></div>
                {d.dueDate && (
                  <div className="flex justify-between gap-6">
                    <span className="text-slate-400">{isQuote ? 'Valid until' : 'Due'}</span>
                    <span className="num text-slate-700">{d.dueDate}</span>
                  </div>
                )}
              </div>
            </div>

            {/* The business's own header block. Sanitised server-side on save and
                again nothing but the allowed subset is ever returned. */}
            {issuer.headerHtml && (
              <div className="tpl mb-6 text-sm text-slate-700"
                dangerouslySetInnerHTML={{ __html: issuer.headerHtml }} />
            )}

            {/* Line items */}
            <table className="mb-6 w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-white">
                  <th className="rounded-l-md py-2 pl-3" style={{ background: accent }}>Description</th>
                  <th className="py-2 text-right" style={{ background: accent }}>Qty</th>
                  <th className="py-2 text-right" style={{ background: accent }}>Unit</th>
                  <th className="rounded-r-md py-2 pr-3 text-right" style={{ background: accent }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-2.5 pl-3 text-slate-700">{l.description}</td>
                    <td className="py-2.5 text-right num text-slate-600">{Number(l.quantity)}</td>
                    <td className="py-2.5 text-right num text-slate-600">{money(l.unitPrice, cur)}</td>
                    <td className="py-2.5 pr-3 text-right num font-medium text-slate-800">{money(l.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div className="mb-8 flex justify-end">
              <div className="w-72 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="num text-slate-700">{money(d.subtotal, cur)}</span></div>
                {discountAmt > 0 && (
                  <div className="flex justify-between"><span className="text-slate-500">Discount</span><span className="num text-slate-700">-{money(discountAmt, cur)}</span></div>
                )}
                {Number(d.taxRate) > 0 && (
                  <div className="flex justify-between"><span className="text-slate-500">Tax ({Number(d.taxRate)}%)</span><span className="num text-slate-700">{money(d.taxAmount, cur)}</span></div>
                )}
                <div className="mt-1 flex justify-between rounded-md px-3 py-2 text-base font-bold text-white" style={{ background: accent }}>
                  <span>Total</span><span className="num">{money(d.total, cur)}</span>
                </div>
              </div>
            </div>

            {/* The business's own closing block, above the payment details. */}
            {issuer.footerHtml && (
              <div className="tpl mb-5 border-t border-slate-200 pt-4 text-sm text-slate-700"
                dangerouslySetInnerHTML={{ __html: issuer.footerHtml }} />
            )}

            {/* Payment details + notes footer */}
            {(issuer.bankDetails || d.notes || issuer.footer) && (
              <div className="grid gap-6 border-t border-slate-200 pt-5 text-sm sm:grid-cols-2">
                {issuer.bankDetails && !isQuote && (
                  <div>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: accent }}>How to pay</div>
                    <div className="whitespace-pre-wrap text-slate-600">{issuer.bankDetails}</div>
                  </div>
                )}
                {(d.notes || issuer.footer) && (
                  <div>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: accent }}>Notes</div>
                    {d.notes && <div className="whitespace-pre-wrap text-slate-600">{d.notes}</div>}
                    {issuer.footer && <div className="mt-1 whitespace-pre-wrap text-slate-400">{issuer.footer}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
