/**
 * Invoice templates: the same content, rendered twice.
 *
 * The ask was "let me edit the invoice with HTML". Taken literally that breaks in
 * two ways. The emailed PDF is drawn by pdfkit, which cannot render HTML at all, so
 * free HTML would restyle the on-screen copy while the client kept receiving the
 * old-looking PDF: two different invoices for the same document. And HTML saved by
 * one person renders in everyone else's browser, which is a script-injection hole.
 *
 * So a template is a RESTRICTED subset that both renderers understand. The tags
 * below survive into the PDF as real bold, italic, headings and bullets; anything
 * else is dropped rather than silently ignored by one renderer and not the other.
 *
 * Two rules make the security work:
 *   1. Sanitising REBUILDS from an allow-list rather than stripping what looks bad,
 *      so an attribute we did not think of cannot survive. Every attribute is
 *      dropped except a validated href.
 *   2. Placeholders are substituted AFTER sanitising, with their values escaped, so
 *      a client named `<script>` cannot become a tag.
 */

import { formatMoney } from './currency.js';

/** Tags that mean the same thing on screen and on paper. */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u',
  'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'a',
]);

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Only ordinary links. Anything else (javascript:, data:) is dropped. */
function safeHref(raw: string): string | null {
  const v = raw.trim().replace(/\s/g, '');
  return /^(https?:\/\/|mailto:)/i.test(v) ? v : null;
}

/**
 * Reduce arbitrary HTML to the allowed subset.
 *
 * Whole elements are removed for script and style, since dropping only their tags
 * would leave their code as visible text.
 */
export function sanitiseTemplate(input: string): string {
  if (!input) return '';
  let html = input;

  // Remove dangerous elements INCLUDING their contents.
  html = html.replace(/<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '');
  // ...and any unclosed opener of the same.
  html = html.replace(/<\/?(script|style|iframe|object|embed|svg|math)\b[^>]*>/gi, '');
  // Comments can hide conditional markup.
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // Rebuild every remaining tag from the allow-list, attributes discarded.
  html = html.replace(/<\/?([a-zA-Z0-9-]+)([^>]*)>/g, (_m, rawName: string, attrs: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    const closing = _m.startsWith('</');
    if (closing) return `</${name}>`;
    if (name === 'a') {
      const m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = m ? safeHref(m[2] ?? m[3] ?? m[4] ?? '') : null;
      // A link with nowhere safe to go stays as text.
      return href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">` : '<a>';
    }
    if (name === 'br' || name === 'hr') return `<${name}>`;
    return `<${name}>`;
  });

  return html.trim();
}

/** The values a template can refer to. */
export interface TemplateData { [key: string]: string | number | null | undefined }

/**
 * Replace {{placeholders}} with escaped values. Runs AFTER sanitising, so data can
 * never introduce markup. An unknown placeholder is left visible rather than
 * silently blanked, because a blank on an invoice is worse than an obvious typo.
 */
export function fillTemplate(html: string, data: TemplateData): string {
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => {
    const v = data[key];
    if (v === undefined) return whole;
    return escapeHtml(v === null ? '' : String(v));
  });
}

/** The placeholders offered in the editor, so the UI and docs cannot drift. */
export const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: 'business.name', label: 'Your business name' },
  { key: 'business.address', label: 'Your address' },
  { key: 'business.vat', label: 'Your VAT number' },
  { key: 'business.reg', label: 'Your registration number' },
  { key: 'client.name', label: "Client's name" },
  { key: 'client.email', label: "Client's email" },
  { key: 'client.vat', label: "Client's VAT number" },
  { key: 'invoice.number', label: 'Document number' },
  { key: 'invoice.issueDate', label: 'Issue date' },
  { key: 'invoice.dueDate', label: 'Due date' },
  { key: 'invoice.total', label: 'Total' },
  { key: 'invoice.currency', label: 'Currency' },
];

// ---- PDF side ---------------------------------------------------------------

export interface PdfRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Heading level, 0 for normal text. */
  heading?: 0 | 1 | 2 | 3;
  bullet?: boolean;
  rule?: boolean;
}

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/**
 * Turn sanitised template HTML into runs pdfkit can draw, so the PDF carries the
 * same emphasis and structure as the screen rather than a flattened blob of text.
 */
export function htmlToPdfRuns(html: string): PdfRun[] {
  if (!html) return [];
  const runs: PdfRun[] = [];
  let bold = false, italic = false, heading: 0 | 1 | 2 | 3 = 0, bullet = false;
  let buf = '';

  const flush = () => {
    const text = decode(buf).replace(/[ \t]+/g, ' ').trim();
    if (text) runs.push({ text, bold, italic, heading, bullet });
    buf = '';
  };

  const tokens = html.split(/(<\/?[a-zA-Z0-9-]+[^>]*>)/g);
  for (const t of tokens) {
    if (!t) continue;
    const tag = /^<(\/?)([a-zA-Z0-9-]+)/.exec(t);
    if (!tag) { buf += t; continue; }
    const closing = tag[1] === '/';
    const name = tag[2]!.toLowerCase();
    switch (name) {
      case 'strong': case 'b': flush(); bold = !closing; break;
      case 'em': case 'i': case 'u': flush(); italic = !closing; break;
      case 'h1': case 'h2': case 'h3':
        flush();
        heading = closing ? 0 : (Number(name[1]) as 1 | 2 | 3);
        break;
      case 'li': flush(); bullet = !closing; break;
      case 'p': case 'ul': case 'ol': flush(); break;
      case 'br': flush(); break;
      case 'hr': flush(); runs.push({ text: '', rule: true }); break;
      default: break;
    }
  }
  flush();
  return runs;
}

/**
 * The values available to a template, gathered in one place so the screen, the PDF
 * and the editor's help all agree on what a placeholder means.
 */
export function templateDataFor(
  doc: Record<string, unknown>,
  business: Record<string, unknown> | undefined,
  account: Record<string, unknown> | undefined,
): TemplateData {
  const pick = (k: string) => (business?.[k] ?? account?.[k] ?? null) as string | null;
  const money = (v: unknown) => formatMoney(Number(v ?? 0), doc.currency as string | null);
  return {
    'business.name': (business?.brandName as string) || (business?.name as string) || (account?.brandName as string) || '',
    'business.address': pick('bizAddress') ?? '',
    'business.vat': pick('bizTaxNumber') ?? '',
    'business.reg': pick('bizRegNumber') ?? '',
    'client.name': (doc.clientName as string) ?? '',
    'client.email': (doc.clientEmail as string) ?? '',
    'client.vat': (doc.clientVatNumber as string) ?? '',
    'invoice.number': (doc.number as string) ?? '',
    'invoice.issueDate': (doc.issueDate as string) ?? '',
    'invoice.dueDate': (doc.dueDate as string) ?? '',
    'invoice.total': money(doc.total),
    'invoice.currency': (doc.currency as string) ?? '',
  };
}
