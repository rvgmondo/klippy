import { fontStack } from './fonts.js';

/**
 * One branded layout for every email Klippy sends.
 *
 * The emails were plain text and read like a machine wrote them, which is a poor
 * showing when the thing being sent is an invoice from someone's business. These
 * carry the business's logo, brand colour and typeface, so a client sees the
 * business rather than the tool it happens to use.
 *
 * Three constraints shape the markup, all of them email-client reality rather than
 * preference:
 *   - Tables, not flexbox or grid. Outlook renders with Word's engine and ignores
 *     modern layout entirely.
 *   - Inline styles. Gmail strips <style> blocks in several contexts, so anything
 *     that must survive is on the element.
 *   - A web font is a progressive enhancement, never a dependency. Most clients
 *     ignore the @import, so the stack always ends in a real system font.
 *
 * Every send also carries a plain-text alternative, which is not politeness: an
 * HTML-only email scores badly with spam filters and is unreadable in a text client.
 */

export interface EmailBrand {
  name: string;
  accent: string;
  logoUrl: string | null;
  /**
   * How big to draw the logo, worked out from the file's real proportions.
   *
   * Email needs explicit width and height attributes: Outlook renders through
   * Word, which ignores CSS sizing and will happily stretch an image to whatever
   * the attributes say. So a wordmark forced into 44x44 is not merely small, it is
   * squashed. These are computed once from the actual file rather than assumed.
   */
  logoWidth: number;
  logoHeight: number;
  fontBody: string | null;
  address: string | null;
  footerNote: string | null;
}

export interface EmailButton { label: string; url: string }

/** A line in the little summary table (label, value). */
export type EmailFact = [string, string];

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Readable text on the accent fill: dark for a bright brand, white for a deep one. */
function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const h = m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? '#14180b' : '#ffffff';
}

export interface EmailContent {
  /** The bold line at the top of the card. */
  heading: string;
  /** Paragraphs, plain text. Escaped for you. */
  body: string[];
  facts?: EmailFact[];
  button?: EmailButton;
  /** Small print under the card. */
  note?: string;
}

/** Build the HTML email. */
export function renderEmail(brand: EmailBrand, content: EmailContent): string {
  const accent = /^#?[0-9a-f]{6}$/i.test(brand.accent.trim()) ? brand.accent.trim() : '#6366f1';
  const ink = inkOn(accent);
  const body = fontStack(brand.fontBody);

  // A square is only right for a square mark. A wordmark keeps its proportions and
  // the cell widens to suit, rather than the mark being crushed to fit the cell.
  const lw = brand.logoWidth || 44;
  const lh = brand.logoHeight || 44;
  const logo = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" width="${lw}" height="${lh}" alt="${esc(brand.name)}" style="display:block;border:0;max-width:100%;height:auto;">`
    : `<div style="width:44px;height:44px;border-radius:8px;background:${accent};color:${ink};font:700 20px/44px ${body};text-align:center;">${esc(brand.name.charAt(0).toUpperCase())}</div>`;

  const facts = (content.facts ?? []).map(([k, v]) => `
        <tr>
          <td style="padding:6px 0;font:400 13px/1.4 ${body};color:#64748b;">${esc(k)}</td>
          <td style="padding:6px 0;font:600 13px/1.4 ${body};color:#0f172a;text-align:right;">${esc(v)}</td>
        </tr>`).join('');

  const button = content.button ? `
      <tr><td style="padding:22px 0 4px;">
        <a href="${esc(content.button.url)}" style="display:inline-block;background:${accent};color:${ink};font:600 14px/1 ${body};text-decoration:none;padding:13px 22px;border-radius:8px;">${esc(content.button.label)}</a>
      </td></tr>` : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(content.heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08);">
      <!-- The brand band: the one place the business's colour carries the message. -->
      <tr><td style="height:5px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:24px 28px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="${brand.logoUrl ? lw : 44}" style="vertical-align:middle;">${logo}</td>
          <td style="padding-left:12px;vertical-align:middle;font:700 16px/1.2 ${body};color:#0f172a;">${esc(brand.name)}</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 28px 0;font:700 20px/1.3 ${body};color:#0f172a;">${esc(content.heading)}</td></tr>
      <tr><td style="padding:8px 28px 0;">
        ${content.body.map((p) => `<p style="margin:0 0 12px;font:400 15px/1.6 ${body};color:#334155;">${esc(p)}</p>`).join('')}
      </td></tr>
      ${facts ? `<tr><td style="padding:4px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">${facts}</table>
      </td></tr>` : ''}
      <tr><td style="padding:0 28px;"><table role="presentation" cellpadding="0" cellspacing="0">${button}</table></td></tr>
      ${content.note ? `<tr><td style="padding:18px 28px 0;font:400 12px/1.5 ${body};color:#94a3b8;">${esc(content.note)}</td></tr>` : ''}
      <tr><td style="padding:24px 28px 26px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:14px;font:400 12px/1.6 ${body};color:#94a3b8;">
          <strong style="color:#64748b;">${esc(brand.name)}</strong>${brand.address ? `<br>${esc(brand.address).replace(/\n/g, '<br>')}` : ''}
          ${brand.footerNote ? `<br><br>${esc(brand.footerNote)}` : ''}
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * The plain-text twin of the same message. Sent alongside every HTML email, so a
 * text-only client still gets something readable and filters see a proper
 * multipart message rather than HTML alone.
 */
export function renderEmailText(brand: EmailBrand, content: EmailContent): string {
  const out = [content.heading, '', ...content.body];
  if (content.facts?.length) {
    out.push('');
    for (const [k, v] of content.facts) out.push(`${k}: ${v}`);
  }
  if (content.button) out.push('', `${content.button.label}: ${content.button.url}`);
  if (content.note) out.push('', content.note);
  out.push('', '--', brand.name);
  if (brand.address) out.push(brand.address);
  return out.join('\n');
}
