import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentSettings, documents, payments, events } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { appUrl } from '../lib/mailer.js';
import { encryptSecret, decryptSecret, secretsAvailable, verifyPayToken } from '../lib/secretbox.js';
import { buildCheckout, verifyItnSignature, validateItnWithServer, signature, } from '../lib/payfast.js';
/** Load and decrypt an account's PayFast credentials, or null if not usable. */
async function loadCreds(accountId) {
    const [row] = await db.select().from(paymentSettings)
        .where(eq(paymentSettings.accountId, accountId)).limit(1);
    if (!row || !row.enabled || !row.merchantId || !row.merchantKeyEnc)
        return null;
    try {
        return {
            merchantId: row.merchantId,
            merchantKey: decryptSecret(row.merchantKeyEnc),
            passphrase: row.passphraseEnc ? decryptSecret(row.passphraseEnc) : null,
            sandbox: row.sandbox,
        };
    }
    catch {
        return null; // bad key / rotated PAYMENTS_SECRET: treat as not configured
    }
}
export async function paymentRoutes(app) {
    // PayFast posts the ITN as application/x-www-form-urlencoded, which Fastify does
    // not parse by default. Capture the RAW body (needed verbatim for the server-side
    // validation step) and also hand back a parsed object. Scoped to this plugin.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        const raw = String(body);
        const parsed = {};
        for (const pair of raw.split('&')) {
            if (!pair)
                continue;
            const i = pair.indexOf('=');
            const k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
            const v = i === -1 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
            parsed[k] = v;
        }
        done(null, { raw, parsed });
    });
    // ---- Settings (owner/admin) ----------------------------------------------
    // Status only. Secrets are never returned; the UI shows whether each is set.
    app.get('/api/v1/account/payfast', { preHandler: app.requireAuth }, async (req) => {
        const { accountId } = authOf(req);
        const [row] = await db.select().from(paymentSettings)
            .where(eq(paymentSettings.accountId, accountId)).limit(1);
        return {
            configured: {
                merchantId: row?.merchantId ?? '',
                hasMerchantKey: !!row?.merchantKeyEnc,
                hasPassphrase: !!row?.passphraseEnc,
                sandbox: row?.sandbox ?? true,
                enabled: row?.enabled ?? false,
            },
            // If this is false, the server cannot encrypt secrets and saving will fail.
            serverReady: secretsAvailable(),
        };
    });
    app.patch('/api/v1/account/payfast', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only workspace admins can change settings.' });
        const parsed = z.object({
            merchantId: z.string().trim().max(40).optional(),
            // Blank string = leave unchanged; a real value = set/replace it.
            merchantKey: z.string().trim().max(120).optional(),
            passphrase: z.string().trim().max(120).nullable().optional(),
            sandbox: z.boolean().optional(),
            enabled: z.boolean().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        if ((d.merchantKey || d.passphrase) && !secretsAvailable()) {
            return reply.code(503).send({ error: 'The server cannot store payment secrets yet. Set PAYMENTS_SECRET in the app environment and restart.' });
        }
        // Turning it on without credentials present would be a footgun.
        if (d.enabled) {
            const [existing] = await db.select().from(paymentSettings).where(eq(paymentSettings.accountId, accountId)).limit(1);
            const willHaveKey = d.merchantKey || existing?.merchantKeyEnc;
            const willHaveId = d.merchantId ?? existing?.merchantId;
            if (!willHaveId || !willHaveKey) {
                return reply.code(400).send({ error: 'Add your merchant ID and key before enabling PayFast.' });
            }
        }
        const patch = {};
        if (d.merchantId !== undefined)
            patch.merchantId = d.merchantId || null;
        if (d.merchantKey)
            patch.merchantKeyEnc = encryptSecret(d.merchantKey);
        if (d.passphrase !== undefined)
            patch.passphraseEnc = d.passphrase ? encryptSecret(d.passphrase) : null;
        if (d.sandbox !== undefined)
            patch.sandbox = d.sandbox;
        if (d.enabled !== undefined)
            patch.enabled = d.enabled;
        const [existing] = await db.select({ id: paymentSettings.id }).from(paymentSettings)
            .where(eq(paymentSettings.accountId, accountId)).limit(1);
        if (existing) {
            await db.update(paymentSettings).set(patch).where(eq(paymentSettings.accountId, accountId));
        }
        else {
            await db.insert(paymentSettings).values(withTenant(accountId, patch));
        }
        return { ok: true };
    });
    // ---- Pay link for an invoice ---------------------------------------------
    // Returns the PayFast process URL and the signed fields to POST there. The client
    // (or an emailed "Pay now" link) submits these and lands on PayFast's checkout.
    app.get('/api/v1/documents/:id/pay-link', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const creds = await loadCreds(accountId);
        if (!creds)
            return reply.code(400).send({ error: 'PayFast is not set up. Add and enable it in Settings > Payments.' });
        const [doc] = await db.select().from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
        if (!doc)
            return reply.code(404).send({ error: 'Invoice not found.' });
        if (doc.type !== 'invoice')
            return reply.code(400).send({ error: 'Only invoices can be paid.' });
        if (doc.status === 'paid')
            return reply.code(400).send({ error: 'This invoice is already paid.' });
        const base = appUrl();
        const checkout = buildCheckout(creds, {
            amount: Number(doc.total),
            itemName: `Invoice ${doc.number}`,
            mPaymentId: `doc-${doc.id}`,
            returnUrl: `${base}/?paid=${doc.number}`,
            cancelUrl: `${base}/?cancelled=${doc.number}`,
            notifyUrl: `${base}/api/v1/payfast/notify`,
            buyerEmail: doc.clientEmail,
        });
        return checkout;
    });
    // ---- Public pay page (PUBLIC: a client opens this from an emailed link) --
    // A signed link, so an invoice id alone cannot be used to reach it. Renders a
    // tiny page that immediately posts the signed fields to PayFast's checkout. Any
    // failure shows a plain message rather than an error, since a client sees this.
    app.get('/api/v1/pay/:id', async (req, reply) => {
        const page = (title, msg) => reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
            + `<title>${title}</title>`
            + `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 24px;text-align:center;color:#0f172a">`
            + `<h1 style="font-size:20px;margin-bottom:8px">${title}</h1><p style="color:#64748b">${msg}</p></div>`);
        const id = Number(req.params.id);
        const token = req.query.t ?? '';
        if (!id || !verifyPayToken(id, token))
            return page('Link not valid', 'This payment link is invalid or has expired.');
        const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
        if (!doc || doc.type !== 'invoice')
            return page('Not found', 'We could not find that invoice.');
        if (doc.status === 'paid')
            return page('Already paid', `Invoice ${doc.number} is already paid. Thank you.`);
        const creds = await loadCreds(doc.accountId);
        if (!creds)
            return page('Online payment unavailable', 'This invoice cannot be paid online right now.');
        const base = appUrl();
        const { url, fields } = buildCheckout(creds, {
            amount: Number(doc.total), itemName: `Invoice ${doc.number}`, mPaymentId: `doc-${doc.id}`,
            returnUrl: `${base}/?paid=${doc.number}`, cancelUrl: `${base}/?cancelled=${doc.number}`,
            notifyUrl: `${base}/api/v1/payfast/notify`, buyerEmail: doc.clientEmail,
        });
        // Auto-submitting form: the client lands here and is taken straight to PayFast.
        const inputs = Object.entries(fields)
            .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('');
        return reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Redirecting to PayFast</title>`
            + `<div style="font-family:system-ui,sans-serif;text-align:center;margin-top:20vh;color:#334155">Taking you to PayFast to pay invoice ${doc.number}...</div>`
            + `<form id="pf" action="${url}" method="post">${inputs}</form>`
            + `<script>document.getElementById('pf').submit()</script>`);
    });
    /**
     * What PayFast has actually sent us, most recent first.
     *
     * Without this a failed payment is invisible: the money leaves the customer, the
     * invoice stays unpaid, and there is nothing to look at. Each row says which
     * check passed or failed and why.
     */
    app.get('/api/v1/account/payfast/activity', { preHandler: app.requireAuth }, async (req) => {
        const { accountId } = authOf(req);
        const rows = await db.select({
            id: events.id, createdAt: events.createdAt,
            payload: events.payload, results: events.results,
        }).from(events)
            .where(and(eq(events.accountId, accountId), eq(events.name, 'payfast.itn')))
            .orderBy(desc(events.id))
            .limit(20);
        return {
            activity: rows.map((r) => ({
                id: r.id, at: r.createdAt,
                ok: r.results?.[0]?.ok ?? false,
                outcome: r.results?.[0]?.outcome ?? '',
                detail: r.payload ?? {},
            })),
        };
    });
    // ---- ITN webhook (PUBLIC: PayFast calls this, no user session) -----------
    // Always answers 200 so PayFast stops retrying, but only records a payment once
    // the notification passes every check: right shape, our signature, the amount we
    // expect, and PayFast's own server confirming it is genuine.
    app.post('/api/v1/payfast/notify', async (req, reply) => {
        const payload = req.body;
        const body = payload?.parsed ?? {};
        const raw = payload?.raw ?? '';
        const ok = () => reply.code(200).send('OK');
        try {
            const mId = body.m_payment_id || '';
            const docId = Number(mId.replace(/^doc-/, ''));
            if (!docId)
                return ok();
            // docId is a global PK, so it identifies the document and thus the account.
            const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
            if (!doc)
                return ok();
            const [settings] = await db.select().from(paymentSettings)
                .where(eq(paymentSettings.accountId, doc.accountId)).limit(1);
            if (!settings || !settings.enabled)
                return ok();
            const passphrase = settings.passphraseEnc ? decryptSecret(settings.passphraseEnc) : null;
            const sigOk = verifyItnSignature(body, passphrase);
            const amountOk = Math.abs(Number(body.amount_gross || 0) - Number(doc.total)) < 0.01;
            const complete = body.payment_status === 'COMPLETE';
            /**
             * Write down what happened, where it can actually be seen.
             *
             * Every rejection used to go to req.log, which on shared hosting means a file
             * nobody reads. A payment that silently does not arrive is the worst possible
             * failure to debug, so each attempt is recorded with the outcome of every
             * check. The signature is recorded too: it is a hash, not a secret, and
             * comparing ours against theirs is what tells you whether the passphrase is
             * the problem.
             */
            const record = async (outcome, ok2) => {
                await db.insert(events).values({
                    accountId: doc.accountId,
                    businessId: doc.businessId,
                    name: 'payfast.itn',
                    payload: {
                        docId, number: doc.number,
                        paymentStatus: body.payment_status ?? '(none)',
                        amountGross: body.amount_gross ?? '(none)',
                        expected: String(doc.total),
                        pfPaymentId: body.pf_payment_id ?? '',
                        sandbox: settings.sandbox,
                        passphraseSet: !!passphrase,
                        signatureTheirs: (body.signature ?? '').slice(0, 12),
                        signatureOurs: signature(body, passphrase).slice(0, 12),
                    },
                    results: [{ handler: 'payfast.itn', outcome, ok: ok2 }],
                }).catch(() => { });
            };
            if (!sigOk || !amountOk || !complete) {
                const why = [
                    !complete && `payment_status is ${body.payment_status || 'missing'}, not COMPLETE`,
                    !sigOk && 'the signature did not match, which usually means the passphrase here differs from the one on your PayFast account',
                    !amountOk && `the amount ${body.amount_gross} does not match the invoice total ${doc.total}`,
                ].filter(Boolean).join('; ');
                req.log.warn({ docId, sigOk, amountOk, status: body.payment_status }, 'payfast ITN rejected');
                await record(`Rejected: ${why}`, false);
                return ok();
            }
            // Definitive check: PayFast confirms it sent this exact payload.
            const serverOk = await validateItnWithServer(raw, settings.sandbox);
            if (!serverOk) {
                req.log.warn({ docId }, 'payfast ITN failed server validation');
                await record('Rejected: PayFast did not confirm this notification when we handed it back. If the sandbox is unreachable from the server this check cannot pass.', false);
                return ok();
            }
            // Idempotency: if we already logged this PayFast payment id, do nothing.
            const pfId = body.pf_payment_id || '';
            const existing = await db.select({ id: payments.id }).from(payments)
                .where(tenantWhere(payments, doc.accountId, eq(payments.documentId, docId)));
            const already = existing.length > 0 && !!pfId
                && (await db.select({ note: payments.note }).from(payments)
                    .where(tenantWhere(payments, doc.accountId, eq(payments.documentId, docId))))
                    .some((p) => p.note?.includes(pfId));
            if (already)
                return ok();
            const today = new Date().toISOString().slice(0, 10);
            await db.insert(payments).values(withTenant(doc.accountId, {
                documentId: docId, amount: Number(body.amount_gross).toFixed(2), paidOn: today,
                method: 'PayFast', note: pfId ? `PayFast ${pfId}` : 'PayFast', createdBy: null,
            }));
            // Mark paid once covered.
            const paidRows = await db.select({ amount: payments.amount }).from(payments)
                .where(tenantWhere(payments, doc.accountId, eq(payments.documentId, docId)));
            const paid = paidRows.reduce((s, p) => s + Number(p.amount), 0);
            if (paid + 0.001 >= Number(doc.total) && doc.status !== 'paid') {
                await db.update(documents).set({ status: 'paid' })
                    .where(tenantWhere(documents, doc.accountId, eq(documents.id, docId)));
            }
            req.log.info({ docId, pfId }, 'payfast payment recorded');
            await record(`Payment of ${body.amount_gross} recorded against ${doc.number}`, true);
            return ok();
        }
        catch (err) {
            req.log.error({ err }, 'payfast ITN handler error');
            return ok(); // never make PayFast retry on our internal error
        }
    });
}
//# sourceMappingURL=payments.js.map