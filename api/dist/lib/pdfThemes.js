import { htmlToPdfRuns } from './template.js';
/**
 * Invoice designs.
 *
 * Five layouts rather than one, because an invoice is a piece of brand collateral
 * and a law firm, a design studio and a hosting company should not send the same
 * looking document. Each is a deliberate design position, not a colour swap.
 *
 * The craft rules applied throughout, which are what separate these from the
 * default "table on a page" invoice:
 *
 *  - The amount due is the second thing you see after who it is from. It gets its
 *    own weight and space; subtotal and tax stay quiet above it.
 *  - Figures are right-aligned with fixed decimals so the decimal points line up.
 *    Ragged numbers are the fastest way to look amateur.
 *  - Hairlines, never zebra striping, which dates a document instantly and fights
 *    the type for attention.
 *  - Body text sits near-black (#1e293b), not mid-grey. Grey that reads fine on a
 *    backlit screen turns weak and thin on paper.
 *  - One accent, used once or twice. A table with a coloured header AND coloured
 *    totals AND a coloured footer has no hierarchy left.
 *  - Generous, consistent margins. Cramped edges are the other instant tell.
 *
 * A note on typefaces: pdfkit can use the standard PDF families with no embedding,
 * but a web font like Inter would need its TTF shipped and licensed. So the choice
 * here is sans, serif or mono, which is a real lever (serif reads established and
 * careful, mono reads technical) rather than a pretend one.
 */
export const PDF_TEMPLATES = ['modern', 'classic', 'bold', 'sidebar', 'compact'];
export const PDF_TYPEFACES = ['sans', 'serif', 'mono'];
export const TEMPLATE_INFO = [
    { key: 'modern', label: 'Modern', blurb: 'Open, quiet, lots of air. The safe one that still looks considered.' },
    { key: 'classic', label: 'Classic', blurb: 'Centred letterhead and fine rules. Reads established and careful.' },
    { key: 'bold', label: 'Bold', blurb: 'A full colour header carrying your name. Confident, hard to ignore.' },
    { key: 'sidebar', label: 'Sidebar', blurb: 'Your details in a tinted column, the numbers beside them. Distinctive.' },
    { key: 'compact', label: 'Compact', blurb: 'Tight and efficient. Best when there are a lot of line items.' },
];
export const TYPEFACE_INFO = [
    { key: 'sans', label: 'Sans', blurb: 'Neutral and current.' },
    { key: 'serif', label: 'Serif', blurb: 'Traditional, reads more formal.' },
    { key: 'mono', label: 'Mono', blurb: 'Technical. Figures align perfectly.' },
];
/**
 * Where the issuer's address, registration and VAT number go.
 *
 * Beside the logo they crowd the top of the page and compete with the document
 * title for the same band, which is the most common way a letterhead goes wrong.
 * As a quiet strip at the foot they read the way legal fine print is meant to,
 * and the header is left to do one job: say who this is from.
 */
export const ISSUER_PLACEMENTS = ['footer', 'header', 'beside'];
export const PLACEMENT_INFO = [
    { key: 'footer', label: 'Fine print at the foot', blurb: 'Cleanest. The header just says who it is from.' },
    { key: 'header', label: 'Under your name', blurb: 'Everything up top, the traditional letterhead.' },
    { key: 'beside', label: 'With the dates', blurb: 'Tucked into the right column under the number.' },
];
const FONTS = {
    sans: { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' },
    serif: { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic', boldItalic: 'Times-BoldItalic' },
    mono: { regular: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique', boldItalic: 'Courier-BoldOblique' },
};
/** Neutral ramp, tuned for print rather than a screen. */
const INK = '#1e293b'; // body text: near-black, holds up on paper
const INK_STRONG = '#0f172a';
const MUTED = '#64748b';
const HAIRLINE = '#d8dee7';
const rgb = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** Ink that stays readable on the accent fill. */
function inkOn(accent) {
    const [r, g, b] = accent;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? INK_STRONG : '#ffffff';
}
// ---- Shared pieces ----------------------------------------------------------
/**
 * The line-item table, with the column geometry each layout passes in.
 *
 * Pagination is handled here rather than per layout: when a table runs past the
 * page it starts a new one AND repeats the header row, because a second page of
 * unlabelled numbers is useless to whoever is checking it.
 */
function drawLines(c, y, opts) {
    const { pdf, d, f } = c;
    const size = opts.size ?? 9.5;
    const gap = opts.rowGap ?? 8;
    const left = opts.left ?? c.M;
    const width = opts.width ?? (c.right - left);
    const colAmt = left + width - 74;
    const colUnit = colAmt - 74;
    const colQty = colUnit - 48;
    const descW = colQty - left - 12;
    const header = (yy) => {
        pdf.font(f.bold).fontSize(size - 1.5).fillColor(opts.accentHeader ? c.accent : MUTED);
        pdf.text('DESCRIPTION', left, yy);
        pdf.text('QTY', colQty, yy, { width: 40, align: 'right' });
        pdf.text('UNIT', colUnit, yy, { width: 64, align: 'right' });
        pdf.text('AMOUNT', colAmt, yy, { width: 74, align: 'right' });
        let out = yy + size + 4;
        if (opts.headerRule !== false) {
            pdf.moveTo(left, out).lineTo(left + width, out)
                .lineWidth(opts.accentHeader ? 1.2 : 0.8)
                .strokeColor(opts.accentHeader ? c.accent : HAIRLINE).stroke();
            out += 7;
        }
        return out;
    };
    y = header(y);
    for (const l of d.lines) {
        const h = pdf.heightOfString(l.description, { width: descW });
        // Break BEFORE drawing a row that would not fit, so a row is never split.
        if (y + h > c.H - 150) {
            pdf.addPage();
            y = header(c.M);
        }
        pdf.font(f.regular).fontSize(size).fillColor(INK);
        pdf.text(l.description, left, y, { width: descW });
        pdf.fillColor(INK);
        pdf.text(l.quantity, colQty, y, { width: 40, align: 'right' });
        pdf.text(l.unitPrice, colUnit, y, { width: 64, align: 'right' });
        pdf.font(f.regular).fillColor(INK_STRONG).text(l.amount, colAmt, y, { width: 74, align: 'right' });
        y += Math.max(h, size + 2) + gap;
        pdf.moveTo(left, y - gap / 2).lineTo(left + width, y - gap / 2)
            .lineWidth(0.5).strokeColor(HAIRLINE).stroke();
    }
    return y + 4;
}
/**
 * The totals block. The amount due is deliberately the loudest thing here: it is
 * the number the reader is looking for, and burying it beside subtotal and tax is
 * the most common failing of a default invoice template.
 */
function drawTotals(c, y, opts) {
    const { pdf, d, f } = c;
    const width = opts.width ?? 250;
    const left = opts.left ?? (c.right - width);
    const line = (k, v) => {
        pdf.font(f.regular).fontSize(9.5).fillColor(MUTED).text(k, left, y, { width: width - 90, align: 'right' });
        pdf.font(f.regular).fontSize(9.5).fillColor(INK).text(v, left + width - 88, y, { width: 88, align: 'right' });
        y += 15;
    };
    line('Subtotal', d.totals.subtotal);
    if (d.totals.discount)
        line('Discount', `-${d.totals.discount}`);
    if (d.totals.taxLabel && d.totals.tax)
        line(d.totals.taxLabel, d.totals.tax);
    y += 3;
    const dueLabel = d.paid ? 'Paid in full' : 'Amount due';
    if (opts.boxed) {
        pdf.roundedRect(left, y, width, 34, 5).fill(c.accent);
        const ink = c.accent === '#ffffff' ? INK_STRONG : inkOn([
            parseInt(c.accent.slice(1, 3), 16), parseInt(c.accent.slice(3, 5), 16), parseInt(c.accent.slice(5, 7), 16),
        ]);
        pdf.font(f.bold).fontSize(10).fillColor(ink).text(dueLabel, left + 12, y + 11);
        pdf.font(f.bold).fontSize(13).fillColor(ink)
            .text(d.totals.total, left + width - 100, y + 9, { width: 88, align: 'right' });
        y += 42;
    }
    else {
        pdf.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(c.accent).stroke();
        y += 8;
        pdf.font(f.bold).fontSize(11).fillColor(INK_STRONG).text(dueLabel, left, y, { width: width - 90, align: 'right' });
        pdf.font(f.bold).fontSize(14).fillColor(INK_STRONG)
            .text(d.totals.total, left + width - 88, y - 2, { width: 88, align: 'right' });
        y += 24;
    }
    return y;
}
/** A template block (header/footer HTML), keeping its emphasis. */
function drawRuns(c, runs, y, width, left = c.M) {
    const { pdf, f } = c;
    for (const r of runs) {
        if (r.rule) {
            pdf.moveTo(left, y + 3).lineTo(left + width, y + 3).lineWidth(0.5).strokeColor(HAIRLINE).stroke();
            y += 10;
            continue;
        }
        const size = r.heading === 1 ? 13 : r.heading === 2 ? 11 : r.heading === 3 ? 10 : 9;
        const font = r.bold || r.heading ? (r.italic ? f.boldItalic : f.bold) : (r.italic ? f.italic : f.regular);
        pdf.font(font).fontSize(size).fillColor(r.heading ? INK_STRONG : INK);
        pdf.text(r.bullet ? `•  ${r.text}` : r.text, left, y, { width });
        y = pdf.y + (r.heading ? 3 : 1);
    }
    return y;
}
/** Bank details and notes, the closing block most layouts share. */
function drawFooterBlocks(c, y, width, left = c.M) {
    const { pdf, d, f } = c;
    if (y > c.H - 130) {
        pdf.addPage();
        y = c.M;
    }
    const half = (width - 24) / 2;
    const startY = y;
    if (d.issuer.bank) {
        pdf.font(f.bold).fontSize(8).fillColor(c.accent).text('HOW TO PAY', left, y);
        pdf.font(f.regular).fontSize(9).fillColor(INK).text(d.issuer.bank, left, pdf.y + 3, { width: half });
    }
    if (d.notes) {
        const nx = d.issuer.bank ? left + half + 24 : left;
        pdf.font(f.bold).fontSize(8).fillColor(c.accent).text('NOTES', nx, startY);
        pdf.font(f.regular).fontSize(9).fillColor(INK).text(d.notes, nx, pdf.y + 3, { width: half });
    }
    return Math.max(pdf.y, startY) + 10;
}
function drawFinePrint(c, left = c.M, width = c.right - c.M) {
    const { pdf, d, f } = c;
    if (!d.issuer.footer)
        return;
    pdf.font(f.regular).fontSize(8).fillColor(MUTED)
        .text(d.issuer.footer, left, c.H - 52, { width, align: 'center' });
}
/** Meta rows (number, dates) as a labelled cluster rather than floating text. */
function drawMeta(c, x, y, width, align = 'right') {
    const { pdf, d, f } = c;
    const rows = [
        ['Number', d.number],
        ['Issued', d.issueDate],
        ...(d.dueDate ? [[d.dueLabel, d.dueDate]] : []),
    ];
    for (const [k, v] of rows) {
        pdf.font(f.regular).fontSize(8.5).fillColor(MUTED)
            .text(k, x, y, { width: width - 96, align });
        pdf.font(f.bold).fontSize(9).fillColor(INK)
            .text(v, align === 'right' ? x + width - 94 : x + 74, y - 0.5, { width: 94, align });
        y += 14;
    }
    return y;
}
function drawBillTo(c, x, y, width) {
    const { pdf, d, f } = c;
    pdf.font(f.bold).fontSize(8).fillColor(c.accent).text('BILL TO', x, y);
    pdf.font(f.bold).fontSize(10.5).fillColor(INK_STRONG).text(d.client.name, x, pdf.y + 3, { width });
    pdf.font(f.regular).fontSize(9).fillColor(MUTED);
    if (d.client.email)
        pdf.text(d.client.email, x, pdf.y + 1, { width });
    if (d.client.address)
        pdf.text(d.client.address, x, pdf.y + 1, { width });
    if (d.client.vat)
        pdf.text(`VAT ${d.client.vat}`, x, pdf.y + 1, { width });
    return pdf.y;
}
function issuerLines(d) {
    return [
        d.issuer.address ?? '',
        [d.issuer.reg && `Reg ${d.issuer.reg}`, d.issuer.vat && `VAT ${d.issuer.vat}`].filter(Boolean).join('   '),
    ].filter(Boolean);
}
/** The issuer details on ONE line, for the fine-print strip at the foot. */
function issuerOneLine(d) {
    return [
        (d.issuer.address ?? '').replace(/\s*\n\s*/g, ', '),
        d.issuer.reg && `Reg ${d.issuer.reg}`,
        d.issuer.vat && `VAT ${d.issuer.vat}`,
    ].filter(Boolean).join('   |   ');
}
/**
 * The fine-print strip: issuer details and terms, hairline-separated, sitting at
 * the foot of the page where legal detail belongs. This is what frees the header
 * to do one job, which was the whole problem with crowding them beside the logo.
 */
function drawIssuerStrip(c, left = c.M, width = c.right - c.M) {
    const { pdf, d, f } = c;
    const details = issuerOneLine(d);
    const terms = d.issuer.footer;
    if (!details && !terms)
        return;
    // Measure first so the rule sits directly above whatever we are about to draw,
    // rather than at a guessed offset that drifts with the amount of text.
    pdf.font(f.regular).fontSize(7.5);
    const dh = details ? pdf.heightOfString(details, { width, align: 'center' }) : 0;
    const th = terms ? pdf.heightOfString(terms, { width, align: 'center' }) : 0;
    const total = dh + th + (details && terms ? 4 : 0);
    const top = c.H - 34 - total;
    pdf.moveTo(left, top - 10).lineTo(left + width, top - 10)
        .lineWidth(0.5).strokeColor(HAIRLINE).stroke();
    let y = top;
    if (details) {
        pdf.font(f.regular).fontSize(7.5).fillColor(MUTED).text(details, left, y, { width, align: 'center' });
        y = pdf.y + 4;
    }
    if (terms) {
        pdf.font(f.regular).fontSize(7.5).fillColor(MUTED).text(terms, left, y, { width, align: 'center' });
    }
}
// ---- The layouts ------------------------------------------------------------
function layoutModern(c) {
    const { pdf, d, f } = c;
    pdf.rect(0, 0, c.W, 5).fill(c.accent);
    // The header does ONE job: who this is from, and what the document is. The logo
    // and name sit on a baseline together with room to breathe; the legal details
    // only join them when explicitly asked for, because squeezed into this band they
    // crowd the logo and fight the title for the same horizontal space.
    const top = 48;
    let tx = c.M;
    if (d.issuer.logo) {
        try {
            pdf.image(d.issuer.logo, c.M, top, { fit: [56, 56] });
            tx = c.M + 72;
        }
        catch { /* skip */ }
    }
    pdf.font(f.bold).fontSize(17).fillColor(INK_STRONG).text(d.issuer.name, tx, top + 4, { width: 250 });
    let ly = pdf.y;
    if (c.issuerAt === 'header') {
        ly += 5;
        for (const l of issuerLines(d)) {
            pdf.font(f.regular).fontSize(8.5).fillColor(MUTED).text(l, tx, ly, { width: 240 });
            ly = pdf.y + 1;
        }
    }
    pdf.font(f.bold).fontSize(24).fillColor(c.accent)
        .text(d.label.toUpperCase(), c.right - 240, top - 4, { width: 240, align: 'right' });
    let metaEnd = drawMeta(c, c.right - 240, pdf.y + 10, 240);
    if (c.issuerAt === 'beside') {
        metaEnd += 6;
        for (const l of issuerLines(d)) {
            pdf.font(f.regular).fontSize(8).fillColor(MUTED)
                .text(l, c.right - 240, metaEnd, { width: 240, align: 'right' });
            metaEnd = pdf.y + 1;
        }
    }
    if (d.paid) {
        pdf.font(f.bold).fontSize(9).fillColor(c.accent)
            .text('PAID', c.right - 240, metaEnd + 4, { width: 240, align: 'right' });
        metaEnd = pdf.y;
    }
    let y = Math.max(ly, metaEnd, top + 62) + 30;
    const billEnd = drawBillTo(c, c.M, y, 260);
    y = billEnd + 24;
    if (d.headerHtml)
        y = drawRuns(c, htmlToPdfRuns(d.headerHtml), y, c.right - c.M) + 14;
    y = drawLines(c, y, { accentHeader: true });
    y = drawTotals(c, y + 10, {});
    y = drawFooterBlocks(c, y + 12, c.right - c.M);
    if (d.footerHtml)
        drawRuns(c, htmlToPdfRuns(d.footerHtml), y + 6, c.right - c.M);
    // With the details at the foot the strip carries them AND the terms; otherwise
    // only the terms need a home down here.
    if (c.issuerAt === 'footer')
        drawIssuerStrip(c);
    else
        drawFinePrint(c);
}
function layoutClassic(c) {
    const { pdf, d, f } = c;
    let y = 54;
    if (d.issuer.logo) {
        try {
            pdf.image(d.issuer.logo, (c.W - 46) / 2, y, { fit: [46, 46] });
            y += 54;
        }
        catch { /* skip */ }
    }
    pdf.font(f.bold).fontSize(15).fillColor(INK_STRONG)
        .text(d.issuer.name.toUpperCase(), c.M, y, { width: c.right - c.M, align: 'center', characterSpacing: 1.2 });
    y = pdf.y + 3;
    for (const l of issuerLines(d)) {
        pdf.font(f.regular).fontSize(8.5).fillColor(MUTED)
            .text(l, c.M, y, { width: c.right - c.M, align: 'center' });
        y = pdf.y;
    }
    // The double rule is the classic letterhead device: one heavy, one hairline.
    y += 12;
    pdf.moveTo(c.M, y).lineTo(c.right, y).lineWidth(1.4).strokeColor(INK_STRONG).stroke();
    pdf.moveTo(c.M, y + 3).lineTo(c.right, y + 3).lineWidth(0.4).strokeColor(INK_STRONG).stroke();
    y += 20;
    pdf.font(f.bold).fontSize(13).fillColor(INK_STRONG)
        .text(d.label.toUpperCase(), c.M, y, { width: c.right - c.M, align: 'center', characterSpacing: 2 });
    y = pdf.y + 18;
    const leftEnd = drawBillTo(c, c.M, y, 240);
    const metaEnd = drawMeta(c, c.right - 230, y, 230);
    y = Math.max(leftEnd, metaEnd) + 22;
    if (d.headerHtml)
        y = drawRuns(c, htmlToPdfRuns(d.headerHtml), y, c.right - c.M) + 12;
    y = drawLines(c, y, { headerRule: true });
    y = drawTotals(c, y + 10, {});
    y = drawFooterBlocks(c, y + 12, c.right - c.M);
    if (d.footerHtml)
        drawRuns(c, htmlToPdfRuns(d.footerHtml), y + 6, c.right - c.M);
    drawFinePrint(c);
}
function layoutBold(c) {
    const { pdf, d, f } = c;
    const ink = inkOn([
        parseInt(c.accent.slice(1, 3), 16), parseInt(c.accent.slice(3, 5), 16), parseInt(c.accent.slice(5, 7), 16),
    ]);
    const BAND = 132;
    pdf.rect(0, 0, c.W, BAND).fill(c.accent);
    let tx = c.M;
    if (d.issuer.logo) {
        try {
            pdf.image(d.issuer.logo, c.M, 30, { fit: [44, 44] });
            tx = c.M + 58;
        }
        catch { /* skip */ }
    }
    pdf.font(f.bold).fontSize(13).fillColor(ink).text(d.issuer.name, tx, 40, { width: 300 });
    pdf.font(f.bold).fontSize(30).fillColor(ink).text(d.label.toUpperCase(), c.M, 82, { width: 320 });
    pdf.font(f.regular).fontSize(11).fillColor(ink)
        .text(d.number, c.right - 220, 86, { width: 220, align: 'right' });
    pdf.font(f.regular).fontSize(9).fillColor(ink)
        .text(`${d.issueDate}${d.dueDate ? `    ${d.dueLabel} ${d.dueDate}` : ''}`, c.right - 220, 104, { width: 220, align: 'right' });
    let y = BAND + 30;
    const billEnd = drawBillTo(c, c.M, y, 250);
    let ry = y;
    if (c.issuerAt !== 'footer') {
        for (const l of issuerLines(d)) {
            pdf.font(f.regular).fontSize(8.5).fillColor(MUTED)
                .text(l, c.right - 220, ry, { width: 220, align: 'right' });
            ry = pdf.y;
        }
    }
    y = Math.max(billEnd, ry) + 24;
    if (d.headerHtml)
        y = drawRuns(c, htmlToPdfRuns(d.headerHtml), y, c.right - c.M) + 12;
    y = drawLines(c, y, { accentHeader: true });
    y = drawTotals(c, y + 12, { boxed: true });
    y = drawFooterBlocks(c, y + 14, c.right - c.M);
    if (d.footerHtml)
        drawRuns(c, htmlToPdfRuns(d.footerHtml), y + 6, c.right - c.M);
    if (c.issuerAt === 'footer')
        drawIssuerStrip(c);
    else
        drawFinePrint(c);
}
function layoutSidebar(c) {
    const { pdf, d, f } = c;
    const SIDE = 168;
    // A tint rather than the full accent: a solid colour column this large would
    // shout over the numbers, which are the point of the page.
    pdf.rect(0, 0, SIDE, c.H).fill(c.accent);
    pdf.rect(0, 0, SIDE, c.H).fillOpacity(0.88).fill('#ffffff');
    pdf.fillOpacity(1);
    pdf.rect(0, 0, 6, c.H).fill(c.accent);
    const sx = 22;
    let sy = 46;
    if (d.issuer.logo) {
        try {
            pdf.image(d.issuer.logo, sx, sy, { fit: [44, 44] });
            sy += 54;
        }
        catch { /* skip */ }
    }
    pdf.font(f.bold).fontSize(12).fillColor(INK_STRONG).text(d.issuer.name, sx, sy, { width: SIDE - sx - 16 });
    sy = pdf.y + 8;
    for (const l of issuerLines(d)) {
        pdf.font(f.regular).fontSize(8).fillColor(MUTED).text(l, sx, sy, { width: SIDE - sx - 16 });
        sy = pdf.y + 4;
    }
    if (d.issuer.bank) {
        sy += 10;
        pdf.font(f.bold).fontSize(7.5).fillColor(c.accent).text('HOW TO PAY', sx, sy);
        pdf.font(f.regular).fontSize(8).fillColor(INK).text(d.issuer.bank, sx, pdf.y + 3, { width: SIDE - sx - 16 });
    }
    const left = SIDE + 34;
    const width = c.right - left;
    let y = 46;
    pdf.font(f.bold).fontSize(22).fillColor(INK_STRONG).text(d.label.toUpperCase(), left, y, { width });
    y = drawMeta(c, left, pdf.y + 10, width) + 14;
    const billEnd = drawBillTo(c, left, y, width);
    y = billEnd + 20;
    if (d.headerHtml)
        y = drawRuns(c, htmlToPdfRuns(d.headerHtml), y, width, left) + 12;
    y = drawLines(c, y, { left, width, accentHeader: true });
    y = drawTotals(c, y + 10, { left: left + width - 230, width: 230 });
    if (d.notes) {
        pdf.font(f.bold).fontSize(8).fillColor(c.accent).text('NOTES', left, y + 8);
        pdf.font(f.regular).fontSize(9).fillColor(INK).text(d.notes, left, pdf.y + 3, { width });
        y = pdf.y;
    }
    if (d.footerHtml)
        drawRuns(c, htmlToPdfRuns(d.footerHtml), y + 10, width, left);
    if (d.issuer.footer) {
        pdf.font(f.regular).fontSize(8).fillColor(MUTED)
            .text(d.issuer.footer, left, c.H - 52, { width, align: 'left' });
    }
}
function layoutCompact(c) {
    const { pdf, d, f } = c;
    let y = c.M;
    let tx = c.M;
    if (d.issuer.logo) {
        try {
            pdf.image(d.issuer.logo, c.M, y, { fit: [34, 34] });
            tx = c.M + 44;
        }
        catch { /* skip */ }
    }
    pdf.font(f.bold).fontSize(12).fillColor(INK_STRONG).text(d.issuer.name, tx, y + 2, { width: 240 });
    const issuerBits = c.issuerAt === 'footer' ? '' : issuerLines(d).join('  |  ');
    if (issuerBits) {
        pdf.font(f.regular).fontSize(7.5).fillColor(MUTED).text(issuerBits, tx, pdf.y + 1, { width: 260 });
    }
    pdf.font(f.bold).fontSize(15).fillColor(c.accent)
        .text(`${d.label.toUpperCase()}  ${d.number}`, c.right - 260, y, { width: 260, align: 'right' });
    pdf.font(f.regular).fontSize(8).fillColor(MUTED)
        .text(`${d.issueDate}${d.dueDate ? `    ${d.dueLabel} ${d.dueDate}` : ''}`, c.right - 260, pdf.y + 2, { width: 260, align: 'right' });
    y = Math.max(pdf.y, y + 40) + 10;
    pdf.moveTo(c.M, y).lineTo(c.right, y).lineWidth(0.8).strokeColor(c.accent).stroke();
    y += 12;
    pdf.font(f.bold).fontSize(8).fillColor(MUTED).text('BILL TO', c.M, y);
    pdf.font(f.bold).fontSize(9.5).fillColor(INK_STRONG).text(d.client.name, c.M + 52, y - 0.5, { width: 260 });
    const extra = [d.client.email, d.client.vat && `VAT ${d.client.vat}`].filter(Boolean).join('  |  ');
    if (extra) {
        pdf.font(f.regular).fontSize(8).fillColor(MUTED).text(extra, c.M + 52, pdf.y + 1, { width: 300 });
    }
    y = pdf.y + 14;
    if (d.headerHtml)
        y = drawRuns(c, htmlToPdfRuns(d.headerHtml), y, c.right - c.M) + 10;
    y = drawLines(c, y, { size: 8.5, rowGap: 5 });
    y = drawTotals(c, y + 8, { width: 210 });
    y = drawFooterBlocks(c, y + 10, c.right - c.M);
    if (d.footerHtml)
        drawRuns(c, htmlToPdfRuns(d.footerHtml), y + 6, c.right - c.M);
    if (c.issuerAt === 'footer')
        drawIssuerStrip(c);
    else
        drawFinePrint(c);
}
const LAYOUTS = {
    modern: layoutModern,
    classic: layoutClassic,
    bold: layoutBold,
    sidebar: layoutSidebar,
    compact: layoutCompact,
};
/** Draw a document in the chosen design. */
export function drawDocument(pdf, d, o) {
    const template = LAYOUTS[o.template] ? o.template : 'modern';
    // Compact earns its name partly through tighter margins.
    const M = template === 'compact' ? 38 : 50;
    const c = {
        pdf, d,
        f: FONTS[o.typeface] ?? FONTS.sans,
        accent: rgb(o.accent),
        W: pdf.page.width, H: pdf.page.height,
        M, right: pdf.page.width - M,
        issuerAt: ISSUER_PLACEMENTS.includes(o.issuer)
            ? o.issuer : 'footer',
    };
    LAYOUTS[template](c);
}
//# sourceMappingURL=pdfThemes.js.map