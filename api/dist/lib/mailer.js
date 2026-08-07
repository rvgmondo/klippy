import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businessEmail, businesses, accounts } from '../db/schema.js';
import { decryptSecret } from './secretbox.js';
/**
 * Sends mail via SMTP if configured (SMTP_HOST etc). If not configured, it
 * logs the message instead of throwing, so flows like password reset still
 * work in dev / before email is set up (the reset link appears in the log).
 */
let transport = null;
function getTransport() {
    if (transport)
        return transport;
    const host = process.env.SMTP_HOST;
    if (!host)
        return null;
    transport = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: Number(process.env.SMTP_PORT ?? 587) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    return transport;
}
export async function sendMail(to, subject, text) {
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
const bizTransports = new Map();
/** The bare address inside a "Name <addr>" from string, for building a fallback. */
function addressOf(from) {
    const m = from.match(/<([^>]+)>/);
    return (m?.[1] ?? from).trim();
}
/**
 * How this business's mail should be addressed and sent for a given purpose.
 * Invoice mail prefers the invoice-specific fields, then the general ones, then the
 * business brand name over the global sending address. A business with its own SMTP
 * is sent through it; otherwise the shared server.
 */
async function resolveBusinessSender(accountId, businessId, purpose) {
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
function safeDecrypt(enc) {
    try {
        return decryptSecret(enc);
    }
    catch {
        return undefined;
    }
}
export async function sendBusinessMail(opts) {
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
export function appUrl() {
    return (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}
/**
 * The brand a business's email should wear. Falls back to the account, then to
 * Klippy, so an email always looks like it came from someone.
 *
 * The logo has to be an absolute URL: an email is read outside the app, so a
 * relative path resolves against the mail client and shows nothing.
 */
export async function emailBrandFor(accountId, businessId) {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const [business] = businessId
        ? await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
        : [undefined];
    const base = appUrl();
    const logoUrl = business?.logoPath
        ? `${base}/api/v1/businesses/${business.id}/logo`
        : account?.logoPath ? `${base}/api/v1/account/logo` : null;
    return {
        name: business?.brandName || business?.name || account?.brandName || 'Klippy',
        accent: business?.invoiceAccent || account?.invoiceAccent || '#6366f1',
        logoUrl,
        fontBody: business?.fontBody ?? null,
        address: business?.bizAddress ?? account?.bizAddress ?? null,
        footerNote: business?.invoiceFooter ?? account?.invoiceFooter ?? null,
    };
}
//# sourceMappingURL=mailer.js.map