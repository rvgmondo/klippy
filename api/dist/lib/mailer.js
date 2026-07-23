import nodemailer from 'nodemailer';
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
export function appUrl() {
    return (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}
//# sourceMappingURL=mailer.js.map