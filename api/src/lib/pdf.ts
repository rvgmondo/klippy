import PDFDocument from 'pdfkit';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, businesses } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
import { fillTemplate, templateDataFor } from './template.js';
import { safeImage } from './imageGuard.js';
import {
  drawDocument, PDF_TEMPLATES, PDF_TYPEFACES, ISSUER_PLACEMENTS,
  type DocData, type PdfTemplate, type PdfTypeface, type IssuerPlacement,
} from './pdfThemes.js';

/**
 * Renders a document to a real PDF, so an emailed invoice arrives as a file the
 * client can file or forward rather than a wall of text they have to trust.
 *
 * pdfkit is pure JavaScript with no native binaries and no headless browser, which
 * is the only workable choice on shared cPanel hosting.
 *
 * This module gathers the data and resolves the business's identity; the drawing
 * lives in pdfThemes.ts, one function per design. Keeping them apart is what makes
 * five layouts practical: a new design is a layout function, not a fork of all the
 * data handling.
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

const isTemplate = (v: unknown): v is PdfTemplate => PDF_TEMPLATES.includes(v as PdfTemplate);
const isTypeface = (v: unknown): v is PdfTypeface => PDF_TYPEFACES.includes(v as PdfTypeface);
const isPlacement = (v: unknown): v is IssuerPlacement => ISSUER_PLACEMENTS.includes(v as IssuerPlacement);

/** Turn a pdfkit document into a buffer. */
function toBuffer(pdf: InstanceType<typeof PDFDocument>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  return new Promise((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
}

/**
 * Build the PDF for one document. Returns null when the document does not exist or
 * is not visible to this account, so callers can carry on without an attachment
 * rather than failing the whole send.
 *
 * `override` lets the settings preview show a design without saving it first.
 */
export async function renderDocumentPdf(
  accountId: number, docId: number,
  override?: { template?: string; typeface?: string; issuer?: string },
): Promise<RenderedDoc | null> {
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
  const vatRegistered = !!pick('bizTaxNumber');
  // A VAT-registered business issues a "Tax Invoice", the wording SARS requires.
  const label = doc.type === 'invoice' && vatRegistered ? 'Tax Invoice' : (LABEL[doc.type] ?? 'Document');

  const logoPath = business?.logoPath ?? account?.logoPath ?? null;
  let logo: Buffer | null = null;
  if (logoPath) {
    // A missing or unreadable logo must never stop an invoice going out.
    // safeImage, not just readFile: a truncated image costs pdfkit ~50 seconds
    // before it throws, which would drag every emailed invoice down with it.
    logo = safeImage(await readFile(path.join(uploadDir(), logoPath)).catch(() => null));
  }

  const cur = doc.currency;
  const money = (v: number | string) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return `${cur} ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  };

  // Custom blocks, sanitised on save, with this document's values filled in.
  const tplData = templateDataFor(
    doc as unknown as Record<string, unknown>,
    business as unknown as Record<string, unknown> | undefined,
    account as unknown as Record<string, unknown> | undefined,
  );

  const data: DocData = {
    label,
    number: doc.number,
    issueDate: doc.issueDate,
    dueDate: doc.dueDate,
    dueLabel: doc.type === 'quote' ? 'Valid until' : 'Due',
    paid: doc.status === 'paid',
    issuer: {
      name: issuerName,
      address: pick('bizAddress'),
      vat: pick('bizTaxNumber'),
      reg: pick('bizRegNumber'),
      bank: doc.type === 'quote' ? null : pick('bankDetails'),
      footer: pick('invoiceFooter'),
      logo,
    },
    client: {
      name: doc.clientName,
      email: doc.clientEmail,
      address: doc.clientAddress,
      vat: doc.clientVatNumber,
    },
    lines: lines.map((l) => ({
      description: l.description,
      quantity: String(Number(l.quantity)),
      unitPrice: money(l.unitPrice),
      amount: money(l.amount),
    })),
    totals: {
      subtotal: money(doc.subtotal),
      discount: Number(doc.discountAmount) > 0 ? money(doc.discountAmount) : null,
      taxLabel: Number(doc.taxRate) > 0 ? `Tax (${Number(doc.taxRate)}%)` : null,
      tax: Number(doc.taxRate) > 0 ? money(doc.taxAmount) : null,
      total: money(doc.total),
    },
    notes: doc.notes,
    headerHtml: business?.invoiceHeaderHtml ? fillTemplate(business.invoiceHeaderHtml, tplData) : null,
    footerHtml: business?.invoiceFooterHtml ? fillTemplate(business.invoiceFooterHtml, tplData) : null,
  };

  const template = isTemplate(override?.template) ? override!.template
    : isTemplate(business?.pdfTemplate) ? business!.pdfTemplate as PdfTemplate : 'modern';
  const typeface = isTypeface(override?.typeface) ? override!.typeface
    : isTypeface(business?.pdfTypeface) ? business!.pdfTypeface as PdfTypeface : 'sans';

  const issuer = isPlacement(override?.issuer) ? override!.issuer
    : isPlacement(business?.pdfIssuerPlacement) ? business!.pdfIssuerPlacement as IssuerPlacement : 'footer';

  const pdf = new PDFDocument({ size: 'A4', margin: 0 });
  const done = toBuffer(pdf);
  drawDocument(pdf, data, {
    template, typeface, issuer,
    accent: hexToRgb(business?.invoiceAccent || account?.invoiceAccent || '#6366f1'),
  });
  pdf.end();
  return { filename: `${doc.number}.pdf`, buffer: await done };
}

/**
 * A worked example, for previewing a design without needing a real invoice. Uses
 * the business's own brand and details so the preview shows THEIR document rather
 * than a generic sample.
 */
export async function renderSamplePdf(
  accountId: number, businessId: number | null,
  opts: { template?: string; typeface?: string; issuer?: string },
): Promise<Buffer> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const [business] = businessId
    ? await db.select().from(businesses).where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1)
    : [undefined];

  const pick = <K extends 'bizAddress' | 'bizTaxNumber' | 'bizRegNumber' | 'bankDetails' | 'invoiceFooter'>(k: K) =>
    (business?.[k] ?? account?.[k] ?? null);
  const logoPath = business?.logoPath ?? account?.logoPath ?? null;
  const logo = logoPath
    ? safeImage(await readFile(path.join(uploadDir(), logoPath)).catch(() => null))
    : null;
  const cur = account?.currency ?? 'ZAR';
  const money = (n: number) => `${cur} ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

  const data: DocData = {
    label: pick('bizTaxNumber') ? 'Tax Invoice' : 'Invoice',
    number: 'INV-0042',
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    dueLabel: 'Due',
    paid: false,
    issuer: {
      name: business?.brandName || business?.name || account?.brandName || 'Your business',
      address: pick('bizAddress'), vat: pick('bizTaxNumber'), reg: pick('bizRegNumber'),
      bank: pick('bankDetails'), footer: pick('invoiceFooter'), logo,
    },
    client: { name: 'Sample Client (Pty) Ltd', email: 'accounts@sampleclient.co.za', address: null, vat: null },
    lines: [
      { description: 'Monthly retainer', quantity: '1', unitPrice: money(12500), amount: money(12500) },
      { description: 'Additional design hours', quantity: '6', unitPrice: money(850), amount: money(5100) },
      { description: 'Hosting and maintenance', quantity: '1', unitPrice: money(1200), amount: money(1200) },
    ],
    totals: {
      subtotal: money(18800), discount: null,
      taxLabel: 'Tax (15%)', tax: money(2820), total: money(21620),
    },
    notes: 'Thank you for your business.',
    headerHtml: null, footerHtml: null,
  };

  const pdf = new PDFDocument({ size: 'A4', margin: 0 });
  const done = toBuffer(pdf);
  drawDocument(pdf, data, {
    template: isTemplate(opts.template) ? opts.template : 'modern',
    typeface: isTypeface(opts.typeface) ? opts.typeface : 'sans',
    issuer: isPlacement(opts.issuer) ? opts.issuer : 'footer',
    accent: hexToRgb(business?.invoiceAccent || account?.invoiceAccent || '#6366f1'),
  });
  pdf.end();
  return done;
}
