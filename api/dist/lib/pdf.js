import PDFDocument from 'pdfkit';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, businesses } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
import { fillTemplate, templateDataFor } from './template.js';
import { safeImage } from './imageGuard.js';
import { DEFAULT_CURRENCY, formatMoney } from './currency.js';
import { drawDocument, PDF_TEMPLATES, PDF_TYPEFACES, ISSUER_PLACEMENTS, } from './pdfThemes.js';
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
function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m)
        return [99, 102, 241];
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const LABEL = { quote: 'Quotation', invoice: 'Invoice', credit_note: 'Credit note' };
const isTemplate = (v) => PDF_TEMPLATES.includes(v);
const isTypeface = (v) => PDF_TYPEFACES.includes(v);
const isPlacement = (v) => ISSUER_PLACEMENTS.includes(v);
/** Turn a pdfkit document into a buffer. */
function toBuffer(pdf) {
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    return new Promise((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
}
/**
 * Build the PDF for one document. Returns null when the document does not exist or
 * is not visible to this account, so callers can carry on without an attachment
 * rather than failing the whole send.
 *
 * `override` lets the settings preview show a design without saving it first.
 */
export async function renderDocumentPdf(accountId, docId, override) {
    const [doc] = await db.select().from(documents)
        .where(tenantWhere(documents, accountId, eq(documents.id, docId))).limit(1);
    if (!doc)
        return null;
    const lines = await db.select().from(documentLines)
        .where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, docId)))
        .orderBy(documentLines.position);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const [business] = doc.businessId
        ? await db.select().from(businesses).where(tenantWhere(businesses, accountId, eq(businesses.id, doc.businessId))).limit(1)
        : [undefined];
    // Same identity rules as the on-screen document: the business first, the account
    // only as a fallback, so a document never wears the wrong company's details.
    const pick = (k) => (business?.[k] ?? account?.[k] ?? null);
    const issuerName = business?.brandName || business?.name || account?.brandName || 'Klippy';
    const vatRegistered = !!pick('bizTaxNumber');
    // A VAT-registered business issues a "Tax Invoice", the wording SARS requires.
    const label = doc.type === 'invoice' && vatRegistered ? 'Tax Invoice' : (LABEL[doc.type] ?? 'Document');
    const logoPath = business?.logoPath ?? account?.logoPath ?? null;
    let logo = null;
    if (logoPath) {
        // A missing or unreadable logo must never stop an invoice going out.
        // safeImage, not just readFile: a truncated image costs pdfkit ~50 seconds
        // before it throws, which would drag every emailed invoice down with it.
        logo = safeImage(await readFile(path.join(uploadDir(), logoPath)).catch(() => null));
    }
    const money = (v) => formatMoney(v, doc.currency);
    // Custom blocks, sanitised on save, with this document's values filled in.
    const tplData = templateDataFor(doc, business, account);
    const data = {
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
            description: l.description, detail: l.detail || null,
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
    const template = isTemplate(override?.template) ? override.template
        : isTemplate(business?.pdfTemplate) ? business.pdfTemplate : 'modern';
    const typeface = isTypeface(override?.typeface) ? override.typeface
        : isTypeface(business?.pdfTypeface) ? business.pdfTypeface : 'sans';
    const issuer = isPlacement(override?.issuer) ? override.issuer
        : isPlacement(business?.pdfIssuerPlacement) ? business.pdfIssuerPlacement : 'footer';
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
export async function renderSamplePdf(accountId, businessId, opts) {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const [business] = businessId
        ? await db.select().from(businesses).where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1)
        : [undefined];
    const pick = (k) => (business?.[k] ?? account?.[k] ?? null);
    const logoPath = business?.logoPath ?? account?.logoPath ?? null;
    const logo = logoPath
        ? safeImage(await readFile(path.join(uploadDir(), logoPath)).catch(() => null))
        : null;
    const cur = business?.currency || account?.currency || DEFAULT_CURRENCY;
    const money = (n) => formatMoney(n, cur);
    const data = {
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
            // One line carries detail and the others do not, which is the realistic mix
            // and the only way the preview shows how the two sit together.
            {
                description: 'Monthly retainer',
                detail: 'Strategy call every fortnight, unlimited small changes, and first call on '
                    + 'design time. Covers the period shown above.',
                quantity: '1', unitPrice: money(12500), amount: money(12500),
            },
            { description: 'Additional design hours', detail: null, quantity: '6', unitPrice: money(850), amount: money(5100) },
            { description: 'Hosting and maintenance', detail: null, quantity: '1', unitPrice: money(1200), amount: money(1200) },
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
/**
 * A client statement as a PDF: the ledger a client reconciles against, branded
 * like every other document the business sends. Fed by lib/statement.ts so the
 * on-screen statement, this PDF and the chase attachment always agree.
 */
export async function renderStatementPdf(accountId, st) {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const [business] = st.client.businessId != null
        ? await db.select().from(businesses)
            .where(tenantWhere(businesses, accountId, eq(businesses.id, st.client.businessId))).limit(1)
        : [undefined];
    const brand = business?.brandName || business?.name || account?.brandName || account?.name || 'Statement';
    const accent = business?.invoiceAccent || account?.invoiceAccent || '#6366f1';
    const [ar, ag, ab] = hexToRgb(accent);
    const money2 = (n) => formatMoney(n, st.currency);
    const pdf = new PDFDocument({ size: 'A4', margin: 46 });
    const done = toBuffer(pdf);
    const left = 46;
    const width = 595.28 - 92;
    // Header band, matching the document family's simplest look.
    pdf.rect(0, 0, 595.28, 5).fill([ar, ag, ab]);
    pdf.fillColor('#0f1729').font('Helvetica-Bold').fontSize(17).text(brand, left, 34);
    pdf.fillColor([ar, ag, ab]).font('Helvetica-Bold').fontSize(19)
        .text('STATEMENT', left, 34, { width, align: 'right' });
    pdf.font('Helvetica').fontSize(9).fillColor('#64748b');
    const period = st.from || st.to
        ? `${st.from ?? 'the beginning'} to ${st.to ?? 'today'}`
        : 'All activity';
    pdf.text(period, left, 60, { width, align: 'right' });
    pdf.fillColor('#64748b').fontSize(8.5).text('STATEMENT FOR', left, 84);
    pdf.fillColor('#0f1729').font('Helvetica-Bold').fontSize(11).text(st.client.name, left, 96);
    // Table.
    let y = 128;
    const cols = { date: left, detail: left + 70, charge: left + width - 190, credit: left + width - 120, balance: left + width - 55 };
    const header = () => {
        pdf.font('Helvetica-Bold').fontSize(8).fillColor('#64748b');
        pdf.text('DATE', cols.date, y);
        pdf.text('DETAIL', cols.detail, y);
        pdf.text('CHARGE', cols.charge, y, { width: 60, align: 'right' });
        pdf.text('CREDIT', cols.credit, y, { width: 60, align: 'right' });
        pdf.text('BALANCE', cols.balance, y, { width: 55, align: 'right' });
        y += 14;
        pdf.moveTo(left, y - 4).lineTo(left + width, y - 4).lineWidth(0.8).strokeColor('#cbd5e1').stroke();
    };
    header();
    const KIND = {
        opening: 'Balance brought forward', invoice: 'Invoice', credit_note: 'Credit note',
        payment: 'Payment', refund: 'Refund',
    };
    for (const e of st.entries) {
        if (y > 780) {
            pdf.addPage();
            y = 46;
            header();
        }
        const isOpening = e.kind === 'opening';
        pdf.font(isOpening ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
            .fillColor(isOpening ? '#0f1729' : '#334155');
        pdf.text(e.date, cols.date, y);
        const label = isOpening ? 'Balance brought forward' : `${KIND[e.kind] ?? e.kind} ${e.ref}${e.detail ? ` (${e.detail})` : ''}`;
        pdf.text(label, cols.detail, y, { width: cols.charge - cols.detail - 8, lineBreak: false });
        if (!isOpening) {
            if (e.charge)
                pdf.text(money2(e.charge), cols.charge, y, { width: 60, align: 'right' });
            if (e.credit)
                pdf.text(money2(e.credit), cols.credit, y, { width: 60, align: 'right' });
        }
        pdf.font('Helvetica-Bold').fillColor('#0f1729')
            .text(money2(e.balance), cols.balance, y, { width: 55, align: 'right' });
        y += 15;
        pdf.moveTo(left, y - 4).lineTo(left + width, y - 4).lineWidth(0.4).strokeColor('#e2e8f0').stroke();
    }
    if (st.entries.length === 0) {
        pdf.font('Helvetica').fontSize(9.5).fillColor('#64748b')
            .text('No activity in this period.', left, y + 6);
        y += 24;
    }
    // Balance owing, loudest thing on the page, same rule as the invoice total.
    y += 12;
    if (y > 760) {
        pdf.addPage();
        y = 60;
    }
    pdf.roundedRect(left + width - 220, y, 220, 40, 6).fill([ar, ag, ab]);
    pdf.fillColor('#ffffff').font('Helvetica').fontSize(8.5).text('BALANCE OWING', left + width - 208, y + 8);
    pdf.font('Helvetica-Bold').fontSize(14).text(money2(st.summary.balance), left + width - 208, y + 19);
    if (st.currencies.length > 1) {
        pdf.font('Helvetica').fontSize(8).fillColor('#64748b')
            .text(`In ${st.currency}. This client has also been billed in ${st.currencies.filter((c) => c !== st.currency).join(', ')}; those are separate statements.`, left, y + 50, { width });
    }
    pdf.end();
    const buffer = await done;
    return { filename: `statement-${st.client.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`, buffer };
}
//# sourceMappingURL=pdf.js.map