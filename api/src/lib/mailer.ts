import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businessEmail, businesses, accounts } from '../db/schema.js';
import { decryptSecret, signLogoToken } from './secretbox.js';
import type { EmailBrand } from './emailLayout.js';

/**
 * Sends mail via SMTP if configured (SMTP_HOST etc). If not configured, it
 * logs the message instead of throwing, so flows like password reset still
 * work in dev / before email is set up (the reset link appears in the log).
 */
let transport: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter | null {
  if (transport) return transport;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransport();
  const from = process.env.SMTP_FROM ?? 'Klippy <no-reply@localhost>';
  if (!t) {
    // eslint-disable-next-line no-console
    console.log(`[mailer:not-configured] would send to ${to}: ${subject}\n${text}`);
    return;
  }
  await t.sendMail({ from, to, subject, text });
}

// ---- Per-business sending ---------------------------------------------------

/** Custom SMTP transports, cached by a signature so a settings change rebuilds. */
const bizTransports = new Map<string, nodemailer.Transporter>();

/** The bare address inside a "Name <addr>" from string, for building a fallback. */
function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m?.[1] ?? from).trim();
}

type Purpose = 'invoice' | 'general';

interface Sender { from: string; replyTo: string | undefined; transport: nodemailer.Transporter | null }

/**
 * How this business's mail should be addressed and sent for a given purpose.
 * Invoice mail prefers the invoice-specific fields, then the general ones, then the
 * business brand name over the global sending address. A business with its own SMTP
 * is sent through it; otherwise the shared server.
 */
async function resolveBusinessSender(accountId: number, businessId: number, purpose: Purpose): Promise<Sender> {
  const [cfg] = await db.select().from(businessEmail)
    .where(eq(businessEmail.businessId, businessId)).limit(1);
  const [biz] = await db.select({ brandName: businesses.brandName, name: businesses.name }).from(businesses)
    .where(eq(businesses.id, businessId)).limit(1);
  const brand = biz?.brandName || biz?.name || 'Invoice';

  const inv = purpose === 'invoice';
  const name = (inv ? cfg?.invoiceFromName : null) || cfg?.fromName || brand;
  const globalAddr = addressOf(process.env.SMTP_FROM ?? 'no-reply@localhost');
  const email = (inv ? cfg?.invoiceFromEmail : null) || cfg?.fromEmail || globalAddr;
  const replyTo = (inv ? cfg?.invoiceReplyTo : null) || cfg?.replyTo || undefined;
  const from = `${name} <${email}>`;

  // Business's own SMTP, if set; else the shared transport.
  let t = getTransport();
  if (cfg?.smtpHost) {
    const sig = `${businessId}:${cfg.smtpHost}:${cfg.smtpPort}:${cfg.smtpUser}:${cfg.updatedAt?.getTime?.() ?? ''}`;
    let cached = bizTransports.get(sig);
    if (!cached) {
      const port = cfg.smtpPort ?? 587;
      cached = nodemailer.createTransport({
        host: cfg.smtpHost, port, secure: cfg.smtpSecure ?? port === 465,
        auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassEnc ? safeDecrypt(cfg.smtpPassEnc) : undefined } : undefined,
      });
      bizTransports.set(sig, cached);
    }
    t = cached;
  }
  return { from, replyTo, transport: t };
}

function safeDecrypt(enc: string): string | undefined {
  try { return decryptSecret(enc); } catch { return undefined; }
}

/**
 * Send a mail addressed as a business (invoices, quotes, reminders). Falls back to
 * logging when nothing can send, exactly like sendMail, so nothing throws for a lack
 * of configuration.
 */
export interface MailAttachment { filename: string; content: Buffer }

export async function sendBusinessMail(opts: {
  accountId: number; businessId: number | null; purpose: Purpose;
  to: string; subject: string; text: string; attachments?: MailAttachment[];
  /** Branded HTML body. Always sent WITH `text`, never instead of it. */
  html?: string;
}): Promise<void> {
  // No business (legacy doc) -> the plain account sender.
  if (!opts.businessId) {
    const t = getTransport();
    if (!t) {
      // eslint-disable-next-line no-console
      console.log(`[mailer:not-configured] would send to ${opts.to}: ${opts.subject}${opts.attachments?.length ? ` (+${opts.attachments.length} attachment)` : ''}`);
      return;
    }
    await t.sendMail({
      from: process.env.SMTP_FROM ?? 'Klippy <no-reply@localhost>',
      to: opts.to, subject: opts.subject, text: opts.text, html: opts.html,
      attachments: opts.attachments,
    });
    return;
  }
  const s = await resolveBusinessSender(opts.accountId, opts.businessId, opts.purpose);
  if (!s.transport) {
    // eslint-disable-next-line no-console
    console.log(`[mailer:not-configured] would send (biz ${opts.businessId}) from ${s.from}${s.replyTo ? ` reply-to ${s.replyTo}` : ''} to ${opts.to}: ${opts.subject}${opts.attachments?.length ? ` (+${opts.attachments.map((a) => a.filename).join(', ')})` : ''}`);
    return;
  }
  await s.transport.sendMail({
    from: s.from, replyTo: s.replyTo, to: opts.to, subject: opts.subject,
    text: opts.text, html: opts.html,
    attachments: opts.attachments,
  });
}

export function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}

/**
 * The brand a business's email should wear. Falls back to the account, then to
 * Klippy, so an email always looks like it came from someone.
 *
 * The logo has to be an absolute URL: an email is read outside the app, so a
 * relative path resolves against the mail client and shows nothing.
 */
/**
 * How big to draw a logo in an email, from the file's real proportions.
 *
 * Targets a 40px height, which sits comfortably beside the business name, and caps
 * the width at 190px so a very wide wordmark cannot push the header card out of
 * shape. Falls back to a square when the file is missing or unreadable, which is
 * the same size the letter-placeholder uses, so the layout does not jump.
 */
async function logoDisplaySize(storedName: string | null): Promise<{ width: number; height: number }> {
  const FALLBACK = { width: 44, height: 44 };
  if (!storedName) return FALLBACK;
  try {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { checkImage } = await import('./imageGuard.js');
    const dir = process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../data/uploads');
    const bytes = await readFile(path.join(dir, storedName));
    const info = checkImage(bytes);
    if (!info.ok || !info.width || !info.height) return FALLBACK;

    const TARGET_H = 40;
    const MAX_W = 190;
    let h = TARGET_H;
    let w = Math.round((info.width / info.height) * h);
    if (w > MAX_W) { w = MAX_W; h = Math.round((info.height / info.width) * w); }
    return { width: Math.max(1, w), height: Math.max(1, h) };
  } catch {
    return FALLBACK;
  }
}

export async function emailBrandFor(accountId: number, businessId: number | null): Promise<EmailBrand> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const [business] = businessId
    ? await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
    : [undefined];
  const base = appUrl();
  // A signed PUBLIC url. The authenticated one returns 401 to a mail client, which
  // is why every branded email showed a broken image instead of a letterhead.
  const bizToken = business?.logoPath ? signLogoToken('business', business.id) : null;
  const accToken = !business?.logoPath && account?.logoPath ? signLogoToken('account', account.id) : null;
  const logoUrl = business?.logoPath && bizToken
    ? `${base}/api/v1/public/logo/business/${business.id}?t=${bizToken}`
    : account?.logoPath && accToken
      ? `${base}/api/v1/public/logo/account/${account.id}?t=${accToken}`
      : null;

  // Measure the actual file so the email can state honest dimensions. A logo that
  // is not there, or unreadable, falls back to the square placeholder rather than
  // blocking the send.
  // Whichever logo the url above actually points at.
  const logoPath = business?.logoPath ?? account?.logoPath ?? null;
  const { width: logoWidth, height: logoHeight } = await logoDisplaySize(logoPath);
  return {
    name: business?.brandName || business?.name || account?.brandName || 'Klippy',
    accent: business?.invoiceAccent || account?.invoiceAccent || '#6366f1',
    logoUrl,
    logoWidth,
    logoHeight,
    fontBody: business?.fontBody ?? null,
    address: business?.bizAddress ?? account?.bizAddress ?? null,
    footerNote: business?.invoiceFooter ?? account?.invoiceFooter ?? null,
  };
}
