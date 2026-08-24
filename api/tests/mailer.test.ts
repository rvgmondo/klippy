import { describe, it, expect } from 'vitest';
import { looksLikeHtml, htmlToText, normalizeBody } from '../src/lib/mailer.js';

// A trimmed version of the digest that reached a real inbox as raw markup.
const DIGEST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Your week in money</title></head>
<body style="margin:0"><table role="presentation"><tr><td>
<h1>Your week in money</h1>
<p>Here is where the business stood over the last seven days.</p>
<table><tr><td>Invoiced (ZAR)</td><td>ZAR 12,000.00</td></tr></table>
</td></tr></table></body></html>`;

describe('the raw-HTML seatbelt', () => {
  it('recognises an HTML document and leaves prose alone', () => {
    expect(looksLikeHtml(DIGEST_HTML)).toBe(true);
    expect(looksLikeHtml('  <table role="presentation">...')).toBe(true);
    expect(looksLikeHtml('Hi Ruben,\n\nInvoice INV-1 is due.')).toBe(false);
    // Prose that merely mentions markup is still prose.
    expect(looksLikeHtml('Use the <b> tag sparingly.')).toBe(false);
  });

  it('derives readable text from the digest markup', () => {
    const text = htmlToText(DIGEST_HTML);
    expect(text).toContain('Your week in money');
    expect(text).toContain('Invoiced (ZAR)');
    expect(text).toContain('ZAR 12,000.00');
    expect(text).not.toContain('<');
    expect(text).not.toContain('doctype');
  });

  it('moves HTML passed as text into the html part with a text fallback', () => {
    const fixed = normalizeBody(DIGEST_HTML);
    expect(fixed.html).toBe(DIGEST_HTML);
    expect(fixed.text).toContain('Your week in money');
    expect(looksLikeHtml(fixed.text)).toBe(false);
  });

  it('leaves a correct text+html pair untouched', () => {
    const pair = normalizeBody('plain words', '<html><body>rich</body></html>');
    expect(pair).toEqual({ text: 'plain words', html: '<html><body>rich</body></html>' });
    const plain = normalizeBody('just words');
    expect(plain).toEqual({ text: 'just words', html: undefined });
  });
});
