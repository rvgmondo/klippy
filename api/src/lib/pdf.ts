import PDFDocument from 'pdfkit';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, businesses } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
import { fillTemplate, htmlToPdfRuns, templateDataFor, type PdfRun } from './template.js';

/**
 * Renders a document to a real PDF, so an emailed invoice arrives as a file the
 * client can file or forward rather than a wall of text they have to trust.
 *
 * pdfkit is pure JavaScript with no native binaries and no headless browser, which
 * is the only workable choice on shared cPanel hosting. The layout deliberately
 * mirrors the on-screen template (accent band, letterhead, lines, totals, bank
 * details) so the printed and emailed copies are recognisably the same document.
 */

const uploadDir = () => process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../data/uploads');

type Rgb = [number, number, number];
function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [99, 102, 241];
  const h = m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const LABEL: Record<string, string> = { quote: 'Quotation', invoice: 'Invoice', credit_note: 'Credit note' };

export interface RenderedDoc { filename: string; buffer: Buffer }

/**
 * Build the PDF for one document. Returns null when the document does not exist or
 * is not visible to this account, so callers can carry on without an attachment
 * rather than failing the whole send.
 */
export async function renderDocumentPdf(accountId: number, docId: number): Promise<RenderedDoc | null> {
  const [doc] = await db.select().from(documents)
    .where(tenantWhere(documents, accountId, eq(documents.id, docId))).limit(1);
  if (!doc) return null;

  const lines = await db.select().from(documentLines)
    .where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, docId)))
    .orderBy(documentLines.position);
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const [business] = doc.businessId
    ? await db.select().from(businesses).where(tenantWhere(businesses, accountId, eq(businesses.id, doc.businessId))).limit(1)
    : [undefined];

  // Same identity rules as the on-screen document: the business first, the account
  // only as a fallback, so a document never wears the wrong company's details.
  const pick = <K extends 'bizAddress' | 'bizTaxNumber' | 'bizRegNumber' | 'bankDetails' | 'invoiceFooter'>(k: K) =>
    (business?.[k] ?? account?.[k] ?? null);
  const issuerName = business?.brandName || business?.name || account?.brandName || 'Klippy';
  const accent = hexToRgb(business?.invoiceAccent || account?.invoiceAccent || '#6366f1');
  const vatRegistered = !!pick('bizTaxNumber');
  // A VAT-registered business issues a "Tax Invoice", the wording SARS requires.
  const label = doc.type === 'invoice' && vatRegistered ? 'Tax Invoice' : (LABEL[doc.type] ?? 'Document');

  const logoPath = business?.logoPath ?? account?.logoPath ?? null;
  let logo: Buffer | null = null;
  if (logoPath) {
    // A missing or unreadable logo must never stop an invoice going out.
    logo = await readFile(path.join(uploadDir(), logoPath)).catch(() => null);
  }

  const cur = doc.currency;
  const money = (v: number | string) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return `${cur} ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  };

  // The business's custom blocks, filled with this document's values. Sanitised
  // when saved, so what arrives here is already the restricted subset.
  const tplData = templateDataFor(doc as unknown as Record<string, unknown>,
    business as unknown as Record<string, unknown> | undefined,
    account as unknown as Record<string, unknown> | undefined);
  const headerRuns = business?.invoiceHeaderHtml
    ? htmlToPdfRuns(fillTemplate(business.invoiceHeaderHtml, tplData)) : [];
  const footerRuns = business?.invoiceFooterHtml
    ? htmlToPdfRuns(fillTemplate(business.invoiceFooterHtml, tplData)) : [];

  const pdf = new PDFDocument({ size: 'A4', margin: 0 });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  const M = 50;                    // page margin
  const W = pdf.page.width;
  const right = W - M;

  /**
   * Draw a template block. The same words as the screen, with the emphasis and
   * structure carried over rather than flattened into one paragraph.
   */
  const drawRuns = (runs: PdfRun[], y0: number, width: number): number => {
    let y = y0;
    for (const r of runs) {
      if (r.rule) {
        pdf.moveTo(M, y + 3).lineTo(M + width, y + 3).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
        y += 10;
        continue;
      }
      const size = r.heading === 1 ? 13 : r.heading === 2 ? 11 : r.heading === 3 ? 10 : 9;
      const font = r.bold || r.heading ? (r.italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold')
        : (r.italic ? 'Helvetica-Oblique' : 'Helvetica');
      const text = r.bullet ? `•  ${r.text}` : r.text;
      pdf.font(font).fontSize(size).fillColor(r.heading ? '#0f172a' : '#475569');
      pdf.text(text, M, y, { width });
      y = pdf.y + (r.heading ? 3 : 1);
    }
    return y;
  };

  // Accent band across the top, matching the on-screen document.
  pdf.rect(0, 0, W, 6).fill(accent);

  // ---- Letterhead ----------------------------------------------------------
  let y = 40;
  let textX = M;
  if (logo) {
    try {
      pdf.image(logo, M, y, { fit: [56, 56] });
      textX = M + 68;
    } catch { /* unsupported image, fall back to text only */ }
  }
  pdf.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text(issuerName, textX, y, { width: 300 });
  let ly = pdf.y + 2;
  const addr = pick('bizAddress');
  if (addr) {
    pdf.font('Helvetica').fontSize(8.5).fillColor('#64748b').text(addr, textX, ly, { width: 250 });
    ly = pdf.y;
  }
  const idBits = [pick('bizRegNumber') && `Reg ${pick('bizRegNumber')}`, pick('bizTaxNumber') && `VAT ${pick('bizTaxNumber')}`]
    .filter(Boolean).join('   ');
  if (idBits) {
    pdf.font('Helvetica').fontSize(8).fillColor('#94a3b8').text(idBits, textX, ly + 1, { width: 250 });
    ly = pdf.y;
  }

  // Document title block, right aligned.
  pdf.font('Helvetica-Bold').fontSize(22).fillColor(accent)
    .text(label.toUpperCase(), right - 220, 40, { width: 220, align: 'right' });
  pdf.font('Helvetica').fontSize(10).fillColor('#64748b')
    .text(doc.number, right - 220, pdf.y + 2, { width: 220, align: 'right' });
  if (doc.status === 'paid') {
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(accent)
      .text('PAID', right - 220, pdf.y + 4, { width: 220, align: 'right' });
  }

  y = Math.max(ly, pdf.y) + 26;

  // ---- Bill to + dates -----------------------------------------------------
  pdf.font('Helvetica-Bold').fontSize(8).fillColor(accent).text('BILL TO', M, y);
  pdf.font('Helvetica-Bold').fontSize(10.5).fillColor('#1e293b').text(doc.clientName, M, pdf.y + 3, { width: 260 });
  pdf.font('Helvetica').fontSize(9).fillColor('#64748b');
  if (doc.clientEmail) pdf.text(doc.clientEmail, M, pdf.y + 1, { width: 260 });
  if (doc.clientAddress) pdf.text(doc.clientAddress, M, pdf.y + 1, { width: 260 });
  if (doc.clientVatNumber) pdf.text(`VAT ${doc.clientVatNumber}`, M, pdf.y + 1, { width: 260 });
  const leftEnd = pdf.y;

  const dateRows: [string, string][] = [['Issued', doc.issueDate]];
  if (doc.dueDate) dateRows.push([doc.type === 'quote' ? 'Valid until' : 'Due', doc.dueDate]);
  let dy = y;
  for (const [k, v] of dateRows) {
    pdf.font('Helvetica').fontSize(9).fillColor('#94a3b8').text(k, right - 200, dy, { width: 100, align: 'right' });
    pdf.font('Helvetica').fontSize(9).fillColor('#334155').text(v, right - 95, dy, { width: 95, align: 'right' });
    dy += 14;
  }

  y = Math.max(leftEnd, dy) + 22;

  // ---- The business's own header block --------------------------------------
  if (headerRuns.length) {
    y = drawRuns(headerRuns, y, right - M) + 12;
  }

  // ---- Line items ----------------------------------------------------------
  const colQty = right - 210, colUnit = right - 150, colAmt = right - 80;
  pdf.font('Helvetica-Bold').fontSize(8).fillColor('#64748b');
  pdf.text('DESCRIPTION', M, y);
  pdf.text('QTY', colQty, y, { width: 50, align: 'right' });
  pdf.text('UNIT', colUnit, y, { width: 60, align: 'right' });
  pdf.text('AMOUNT', colAmt, y, { width: 80, align: 'right' });
  y += 14;
  pdf.moveTo(M, y).lineTo(right, y).lineWidth(1).strokeColor(accent).stroke();
  y += 8;

  pdf.font('Helvetica').fontSize(9.5);
  for (const l of lines) {
    // Start a new page before a row would run off the bottom.
    if (y > pdf.page.height - 150) { pdf.addPage(); y = M; }
    const h = pdf.heightOfString(l.description, { width: colQty - M - 10 });
    pdf.fillColor('#334155').text(l.description, M, y, { width: colQty - M - 10 });
    pdf.fillColor('#475569');
    pdf.text(String(Number(l.quantity)), colQty, y, { width: 50, align: 'right' });
    pdf.text(money(l.unitPrice), colUnit, y, { width: 60, align: 'right' });
    pdf.text(money(l.amount), colAmt, y, { width: 80, align: 'right' });
    y += Math.max(h, 12) + 7;
    pdf.moveTo(M, y - 4).lineTo(right, y - 4).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  }

  // ---- Totals --------------------------------------------------------------
  y += 8;
  if (y > pdf.page.height - 160) { pdf.addPage(); y = M; }
  const totalRow = (k: string, v: string, bold = false) => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5)
      .fillColor(bold ? '#0f172a' : '#64748b').text(k, right - 260, y, { width: 150, align: 'right' });
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5)
      .fillColor(bold ? '#0f172a' : '#334155').text(v, right - 100, y, { width: 100, align: 'right' });
    y += bold ? 18 : 15;
  };
  totalRow('Subtotal', money(doc.subtotal));
  if (Number(doc.discountAmount) > 0) totalRow('Discount', `-${money(doc.discountAmount)}`);
  if (Number(doc.taxRate) > 0) totalRow(`Tax (${Number(doc.taxRate)}%)`, money(doc.taxAmount));
  pdf.moveTo(right - 260, y).lineTo(right, y).lineWidth(1).strokeColor('#cbd5e1').stroke();
  y += 8;
  totalRow('Total', money(doc.total), true);

  // ---- Payment details + notes --------------------------------------------
  y += 16;
  if (y > pdf.page.height - 120) { pdf.addPage(); y = M; }
  const bank = pick('bankDetails');
  if (bank && doc.type !== 'quote') {
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(accent).text('HOW TO PAY', M, y);
    pdf.font('Helvetica').fontSize(9).fillColor('#475569').text(bank, M, pdf.y + 3, { width: 240 });
  }
  if (doc.notes) {
    const nx = bank && doc.type !== 'quote' ? M + 270 : M;
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(accent).text('NOTES', nx, y);
    pdf.font('Helvetica').fontSize(9).fillColor('#475569').text(doc.notes, nx, pdf.y + 3, { width: 240 });
  }
  // The business's own closing block, above the one-line footer.
  if (footerRuns.length) {
    y = Math.max(y, pdf.y) + 14;
    if (y > pdf.page.height - 120) { pdf.addPage(); y = M; }
    drawRuns(footerRuns, y, right - M);
  }

  const footer = pick('invoiceFooter');
  if (footer) {
    pdf.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text(footer, M, pdf.page.height - 60, { width: right - M, align: 'center' });
  }

  pdf.end();
  const buffer = await done;
  return { filename: `${doc.number}.pdf`, buffer };
}
