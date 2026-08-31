import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentSettings, documents, payments, events, subscriptions } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { appUrl, sendBusinessMail, emailBrandFor } from '../lib/mailer.js';
import { renderEmail, renderEmailText } from '../lib/emailLayout.js';
import { balanceOf } from '../lib/balances.js';
import { settleIfCovered } from '../lib/settle.js';
import { formatMoney } from '../lib/currency.js';
import { encryptSecret, decryptSecret, secretsAvailable, verifyPayToken } from '../lib/secretbox.js';
import { credsFor, settingsFor } from '../lib/paymentSettings.js';
import { notifyAdmins } from '../lib/notify.js';
import { assertBusinessAccess } from '../lib/access.js';
import { isDuplicateKey } from '../lib/tenant.js';
import { buildCheckout, verifyItnSignature, validateItnWithServer, signature, } from '../lib/payfast.js';
import { payfastSupports } from '../lib/currency.js';
/**
 * Should this checkout ask PayFast to store the card?
 *
 * Only when the invoice came from a subscription that is set to auto-debit and has
 * no card stored yet. Asking every time would change what the client agrees to at
 * the PayFast page for one-off invoices, which is not ours to do quietly.
 */
async function shouldTokenize(doc) {
    if (!doc.subscriptionId)
        return false;
    const [sub] = await db.select({ autoDebit: subscriptions.autoDebit, token: subscriptions.payfastToken })
        .from(subscriptions)
        .where(tenantWhere(subscriptions, doc.accountId, eq(subscriptions.id, doc.subscriptionId))).limit(1);
    return !!sub?.autoDebit && !sub.token;
}
/** The pay pages are hand-built HTML, so anything from the database is escaped. */
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    // The same pair of handlers serves the workspace default and each business, so
    // there is one code path deciding what may be saved rather than two that drift.
    // Scope 0 is the workspace; any other value is that business's own gateway.
    const readSettings = async (accountId, businessId) => {
        const [row] = await db.select().from(paymentSettings)
            .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, businessId)))
            .limit(1);
        // What would actually be used if this business took a payment right now, which
        // is not the same question as what is stored against it.
        const effective = businessId ? await settingsFor(accountId, businessId) : row;
        return {
            configured: {
                merchantId: row?.merchantId ?? '',
                hasMerchantKey: !!row?.merchantKeyEnc,
                hasPassphrase: !!row?.passphraseEnc,
                sandbox: row?.sandbox ?? true,
                enabled: row?.enabled ?? false,
                autoDebitEnabled: row?.autoDebitEnabled ?? false,
                autoDebitLive: row?.autoDebitLive ?? false,
                autoDebitMax: row?.autoDebitMax ?? '5000.00',
            },
            // Where the money would go, spelled out, so nobody has to infer it.
            source: businessId ? (row ? 'own' : (effective ? 'workspace' : 'none')) : (row ? 'own' : 'none'),
            effectiveMerchantId: effective?.enabled ? (effective.merchantId ?? '') : '',
            serverReady: secretsAvailable(),
        };
    };
    const writeSettings = async (accountId, businessId, body, reply) => {
        const parsed = z.object({
            merchantId: z.string().trim().max(40).optional(),
            // Blank string = leave unchanged; a real value = set/replace it.
            merchantKey: z.string().trim().max(120).optional(),
            passphrase: z.string().trim().max(120).nullable().optional(),
            sandbox: z.boolean().optional(),
            enabled: z.boolean().optional(),
            autoDebitEnabled: z.boolean().optional(),
            autoDebitLive: z.boolean().optional(),
            autoDebitMax: z.number().positive().max(1000000).optional(),
        }).safeParse(body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        if ((d.merchantKey || d.passphrase) && !secretsAvailable()) {
            return reply.code(503).send({ error: 'The server cannot store payment secrets yet. Set PAYMENTS_SECRET in the app environment and restart.' });
        }
        const scope = and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, businessId));
        const [existing] = await db.select().from(paymentSettings).where(scope).limit(1);
        // Turning it on without credentials present would be a footgun.
        if (d.enabled) {
            const willHaveKey = d.merchantKey || existing?.merchantKeyEnc;
            const willHaveId = d.merchantId ?? existing?.merchantId;
            if (!willHaveId || !willHaveKey) {
                return reply.code(400).send({ error: 'Add your merchant ID and key before enabling PayFast.' });
            }
        }
        // Live charging is the one switch that can move money on its own, so it cannot
        // be reached without PayFast itself being on and auto-debit deliberately
        // enabled. Turning either of those off drops live charging with it, rather than
        // leaving it armed for whenever they come back on.
        if (d.autoDebitLive) {
            const on = d.enabled ?? existing?.enabled;
            const auto = d.autoDebitEnabled ?? existing?.autoDebitEnabled;
            const sand = d.sandbox ?? existing?.sandbox;
            if (!on || !auto) {
                return reply.code(400).send({ error: 'Switch PayFast and auto-debit on before enabling live charging.' });
            }
            // Live charging against the test gateway is the worst of both: no money moves,
            // and Klippy would record that it did.
            if (sand) {
                return reply.code(400).send({ error: 'Switch PayFast out of sandbox mode before enabling live charging, or nothing will actually be charged.' });
            }
        }
        const patch = {};
        if (d.autoDebitEnabled !== undefined) {
            patch.autoDebitEnabled = d.autoDebitEnabled;
            if (!d.autoDebitEnabled)
                patch.autoDebitLive = false;
        }
        if (d.enabled === false)
            patch.autoDebitLive = false;
        if (d.autoDebitLive !== undefined)
            patch.autoDebitLive = d.autoDebitLive;
        // Going back into sandbox disarms live charging with it, rather than leaving it
        // armed for whoever switches sandbox off again months later.
        if (d.sandbox === true)
            patch.autoDebitLive = false;
        if (d.autoDebitMax !== undefined)
            patch.autoDebitMax = d.autoDebitMax.toFixed(2);
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
        if (existing) {
            await db.update(paymentSettings).set(patch).where(scope);
        }
        else {
            await db.insert(paymentSettings).values(withTenant(accountId, { ...patch, businessId }));
        }
        return { ok: true };
    };
    app.get('/api/v1/account/payfast', { preHandler: app.requireAuth }, async (req) => {
        const { accountId } = authOf(req);
        return readSettings(accountId, 0);
    });
    app.patch('/api/v1/account/payfast', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only workspace admins can change settings.' });
        return writeSettings(accountId, 0, req.body, reply);
    });
    // Each business can bank its own money. Guarded by access to that business, not
    // just by being a workspace admin.
    app.get('/api/v1/businesses/:id/payfast', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertBusinessAccess(req, reply, id, 'admin')))
            return;
        return readSettings(accountId, id);
    });
    app.patch('/api/v1/businesses/:id/payfast', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertBusinessAccess(req, reply, id, 'admin')))
            return;
        return writeSettings(accountId, id, req.body, reply);
    });
    // Stop using this business's own gateway and fall back to the workspace one.
    app.delete('/api/v1/businesses/:id/payfast', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertBusinessAccess(req, reply, id, 'admin')))
            return;
        await db.delete(paymentSettings)
            .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, id)));
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
        const [doc] = await db.select().from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
        if (!doc)
            return reply.code(404).send({ error: 'Invoice not found.' });
        // Resolved from the invoice's business, so each business is paid into its own
        // merchant account rather than whichever one was set up first.
        // Two different reasons, two different answers. Telling someone to go and set
        // up PayFast for a dollar invoice sends them to configure something that could
        // never have worked, and they would come back none the wiser.
        if (!payfastSupports(doc.currency)) {
            return reply.code(400).send({
                error: `PayFast settles rand only, and this invoice is in ${doc.currency}. Collect it by transfer using the bank details on the invoice.`,
            });
        }
        const creds = await credsFor(accountId, doc.businessId, doc.currency);
        if (!creds)
            return reply.code(400).send({ error: 'PayFast is not set up for this business. Add it under the business, or set a workspace default in Settings > Payments.' });
        if (doc.type !== 'invoice')
            return reply.code(400).send({ error: 'Only invoices can be paid.' });
        if (doc.status === 'paid')
            return reply.code(400).send({ error: 'This invoice is already paid.' });
        // Charge what is STILL OWED, not the face value. An invoice with a recorded
        // deposit or a credit note against it must ask for the remainder, or the client
        // is overcharged and has to be refunded by hand.
        const owed = (await balanceOf(accountId, doc.id, Number(doc.total))).outstanding;
        if (owed <= 0.001)
            return reply.code(400).send({ error: 'Nothing is outstanding on this invoice.' });
        const base = appUrl();
        const checkout = buildCheckout(creds, {
            amount: owed,
            itemName: `Invoice ${doc.number}`,
            mPaymentId: `doc-${doc.id}`,
            returnUrl: `${base}/?paid=${doc.number}`,
            cancelUrl: `${base}/?cancelled=${doc.number}`,
            notifyUrl: `${base}/api/v1/payfast/notify`,
            buyerEmail: doc.clientEmail,
            tokenize: await shouldTokenize(doc),
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
        const creds = await credsFor(doc.accountId, doc.businessId, doc.currency);
        // A client is reading this page, so the wording stays plain and points at the
        // thing they can actually do rather than at our gateway's limitations.
        if (!creds) {
            return page('Online payment unavailable', payfastSupports(doc.currency)
                ? 'This invoice cannot be paid online right now.'
                : `Invoices in ${doc.currency} cannot be paid by card here. Please use the bank details on your invoice.`);
        }
        const balance = await balanceOf(doc.accountId, doc.id, Number(doc.total));
        const owed = balance.outstanding;
        if (owed <= 0.001)
            return page('Already paid', `Invoice ${doc.number} is already settled. Thank you.`);
        /**
         * A deposit is only a deposit before anything has been paid. Once the client
         * has put something down, the only meaningful figure is what is left, so the
         * choice disappears rather than offering to take the deposit twice.
         */
        const deposit = Number(doc.depositAmount);
        const depositOpen = deposit > 0.001 && deposit < owed - 0.001 && balance.paid <= 0.001;
        const choice = req.query.pay;
        // With a deposit outstanding and no choice made yet, ask instead of assuming.
        // Sending a client straight to a card form for the full amount when the
        // agreement was "half to start" is how a job stalls at the payment step.
        if (depositOpen && choice !== 'deposit' && choice !== 'full') {
            const link = (q, label, amount, primary) => `<a href="/api/v1/pay/${doc.id}?t=${encodeURIComponent(token)}&pay=${q}" `
                + `style="display:block;padding:14px 18px;border-radius:10px;margin-bottom:10px;text-decoration:none;font-size:15px;`
                + (primary
                    ? `background:#0f172a;color:#fff;font-weight:600;`
                    : `border:1px solid #cbd5e1;color:#0f172a;`)
                + `">${label}<span style="float:right">${formatMoney(amount, doc.currency)}</span></a>`;
            return reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
                + `<title>Pay invoice ${esc(doc.number)}</title>`
                + `<body style="margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a">`
                + `<div style="max-width:420px;margin:10vh auto;padding:0 24px">`
                + `<h1 style="font-size:20px;margin-bottom:4px">Invoice ${esc(doc.number)}</h1>`
                + `<p style="color:#64748b;font-size:14px;margin-bottom:20px">`
                + `The total is ${formatMoney(owed, doc.currency)}. You can settle it in full, or pay the deposit now and the rest later.</p>`
                + link('deposit', 'Pay the deposit', deposit, true)
                + link('full', 'Pay in full', owed, false)
                + `</div></body>`);
        }
        const amount = choice === 'deposit' && depositOpen ? deposit : owed;
        const base = appUrl();
        const { url, fields } = buildCheckout(creds, {
            amount, itemName: `Invoice ${doc.number}${choice === 'deposit' ? ' (deposit)' : ''}`, mPaymentId: `doc-${doc.id}`,
            returnUrl: `${base}/?paid=${doc.number}`, cancelUrl: `${base}/?cancelled=${doc.number}`,
            notifyUrl: `${base}/api/v1/payfast/notify`, buyerEmail: doc.clientEmail,
            tokenize: await shouldTokenize(doc),
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
    /**
     * Every auto-debit attempt, newest first, including the ones that were refused.
     *
     * A skipped charge matters as much as a successful one here: "over the limit" or
     * "no saved card" is the difference between a client who was billed and one who
     * quietly was not, and that only shows up as an unpaid invoice weeks later.
     */
    app.get('/api/v1/account/autodebit/activity', { preHandler: app.requireAuth }, async (req) => {
        const { accountId } = authOf(req);
        const rows = await db.select({
            id: events.id, createdAt: events.createdAt,
            payload: events.payload, results: events.results,
        }).from(events)
            .where(and(eq(events.accountId, accountId), eq(events.name, 'payfast.autodebit')))
            .orderBy(desc(events.id))
            .limit(25);
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
        /**
         * When we may ask PayFast to send this again.
         *
         * PayFast re-sends an ITN only when it does not get a 200, so answering 200 to
         * our OWN failure threw away the gateway's retry and, with it, the payment: the
         * money had moved, and no row, no event and no notification survived here.
         *
         * A retry is only safe when the notification carries a pf_payment_id, because
         * that is the column the unique index dedupes on. MySQL allows unlimited NULLs
         * in a unique index, so retrying an id-less ITN would insert one payment row per
         * delivery. An id-less ITN is therefore still answered 200 and never retried.
         */
        const canRetry = !!(payload?.parsed?.pf_payment_id);
        const fail = () => (canRetry ? reply.code(500).send('ERROR') : ok());
        try {
            const mId = body.m_payment_id || '';
            const docId = Number(mId.replace(/^doc-/, ''));
            if (!docId)
                return ok();
            // docId is a global PK, so it identifies the document and thus the account.
            const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
            if (!doc)
                return ok();
            // The same resolver the checkout used, so the signature is checked against
            // the passphrase of the merchant account that actually took the money.
            const settings = await settingsFor(doc.accountId, doc.businessId);
            if (!settings || !settings.enabled)
                return ok();
            const passphrase = settings.passphraseEnc ? decryptSecret(settings.passphraseEnc) : null;
            const sigOk = verifyItnSignature(body, passphrase);
            // Accept any positive payment up to the invoice total, not only the exact
            // total. Charging the OUTSTANDING balance (a deposit, or the remainder after
            // one) is a genuine payment; demanding the full face value here made partial
            // and deposit payments impossible and rejected the very balance-based checkout
            // this webhook is paired with.
            const gross = Number(body.amount_gross || 0);
            const amountOk = gross > 0 && gross <= Number(doc.total) + 0.01;
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
                    !amountOk && `the amount ${body.amount_gross} is not a valid payment against an invoice total of ${doc.total}`,
                ].filter(Boolean).join('; ');
                req.log.warn({ docId, sigOk, amountOk, status: body.payment_status }, 'payfast ITN rejected');
                await record(`Rejected: ${why}`, false);
                return ok();
            }
            // Definitive check: PayFast confirms it sent this exact payload.
            const serverCheck = await validateItnWithServer(raw, settings.sandbox);
            if (!serverCheck.ok) {
                req.log.warn({ docId, reason: serverCheck.reason }, 'payfast ITN failed server validation');
                if (serverCheck.reason === 'unreachable') {
                    // Our side could not reach PayFast, which says nothing about the payment.
                    // Record it and ask for the notification again rather than discarding a
                    // payment that may well be genuine.
                    await record('Could not reach PayFast to confirm this notification, so nothing was recorded yet. We have asked them to send it again.', false);
                    return fail();
                }
                await record('Rejected: PayFast did not confirm this notification when we handed it back.', false);
                return ok();
            }
            // Idempotency by DB constraint, not by scanning. PayFast retries ITNs and can
            // deliver two at once; a read-then-insert let both pass the "already?" check
            // and insert twice, doubling the paid total. The unique index on pf_payment_id
            // makes the second insert fail, and we treat that failure as "already recorded".
            const pfId = body.pf_payment_id || '';
            const today = new Date().toISOString().slice(0, 10);
            let duplicate = false;
            try {
                await db.insert(payments).values(withTenant(doc.accountId, {
                    documentId: docId, amount: Number(body.amount_gross).toFixed(2), paidOn: today,
                    method: 'PayFast', pfPaymentId: pfId || null,
                    // What PayFast kept, and what actually reached the bank. It has been telling
                    // us both on every notification all along; only the gross was ever read, so
                    // the cost of taking money online was invisible and profit was overstated by
                    // exactly that amount. Only stored when the gateway actually sent it.
                    feeAmount: body.amount_fee != null && body.amount_fee !== ''
                        ? Math.abs(Number(body.amount_fee)).toFixed(2) : null,
                    netAmount: body.amount_net != null && body.amount_net !== ''
                        ? Number(body.amount_net).toFixed(2) : null,
                    note: pfId ? `PayFast ${pfId}` : 'PayFast', createdBy: null,
                }));
            }
            catch (e) {
                if (isDuplicateKey(e))
                    duplicate = true;
                else {
                    // Everything has passed: the signature, the amount, and PayFast itself. The
                    // money HAS moved and we could not write it down. This used to rethrow into
                    // the outer catch, which answered 200, so the gateway never sent it again
                    // and the payment was gone for good. Ask for a retry instead, and say so
                    // where somebody will see it. Both of those writes can fail too if the
                    // database is what broke; the 500 is the part that still works.
                    req.log.error({ err: e, docId }, 'payfast ITN could not record the payment');
                    await record(`Could not record this payment (${body.amount_gross}). PayFast has been asked to send it again.`, false);
                    await notifyAdmins(doc.accountId, {
                        kind: 'payment',
                        title: `Payment may not be recorded: ${doc.number}`,
                        body: `${doc.clientName} paid ${formatMoney(Number(body.amount_gross), doc.currency)} but Klippy could not save it. Check the invoice against your PayFast dashboard.`,
                        url: '/?v=billing',
                    });
                    return fail();
                }
            }
            /**
             * Settle, credit notes included.
             *
             * This ran on a hand-rolled sum against the invoice's FACE value, with no term
             * for credit notes, while the pay link and the portal both charge the
             * outstanding amount. Any invoice with a credit note against it was therefore
             * charged the reduced figure and tested against the full one, so it could never
             * settle: the client paid, and the invoice stayed unpaid and kept being chased.
             *
             * Wrapped, because the token capture below is worth real money later: if this
             * throws to the outer catch we lose the stored card and auto-debit has nothing
             * to charge. The payment row is already written either way.
             */
            let bal = null;
            let settled = false;
            try {
                ({ bal, settled } = await settleIfCovered(doc.accountId, docId, Number(doc.total), doc.status));
            }
            catch { /* the payment is recorded either way */ }
            // If this checkout asked PayFast to store the card, the reusable token comes
            // back on the ITN and this is the only place it is ever offered. Miss it and
            // auto-debit has nothing to charge, so it is saved against the subscription
            // straight away. Never overwritten: a token already stored is the one the
            // client agreed to, and replacing it silently would be the wrong card.
            //
            // ABOVE the duplicate return on purpose. If the first delivery recorded the
            // payment and then died before this line, the card would be lost for good,
            // because every retry is a duplicate and used to return before reaching here.
            const token = body.token || '';
            if (token && doc.subscriptionId) {
                await db.update(subscriptions).set({ payfastToken: token })
                    .where(and(tenantWhere(subscriptions, doc.accountId, eq(subscriptions.id, doc.subscriptionId)), isNull(subscriptions.payfastToken)))
                    .catch(() => { });
            }
            // A redelivery still reconciles above before returning, so an invoice whose
            // first delivery recorded the payment and then failed to flip the status is
            // repaired by the retry rather than chased forever.
            if (duplicate) {
                await record('Duplicate ITN ignored; this payment was already recorded.', true);
                return ok();
            }
            await notifyAdmins(doc.accountId, {
                kind: 'payment',
                title: `Payment received: ${formatMoney(Number(body.amount_gross), doc.currency)}`,
                body: `${doc.clientName} paid invoice ${doc.number} via PayFast.`,
                url: '/?v=billing',
            });
            /**
             * Say so when a client has paid too much.
             *
             * Recording the payment is right: PayFast confirmed it, so the money really did
             * leave their account, and refusing it here would hide a charge that actually
             * happened. But nothing anywhere looked at a NEGATIVE balance, so a client who
             * paid twice (two tabs, or a retry after a timeout) was quietly out of pocket
             * with no screen in Klippy saying so. The money is theirs to get back, and the
             * only way anyone finds out is if this says it.
             */
            if (bal && bal.outstanding < -0.01) {
                await notifyAdmins(doc.accountId, {
                    kind: 'payment',
                    title: `${doc.number} has been overpaid`,
                    body: `${doc.clientName} has paid ${formatMoney(Math.abs(bal.outstanding), doc.currency)} more than this invoice asks for. They may have paid twice, in which case you owe them a refund.`,
                    url: '/?v=billing',
                });
            }
            // Email the client a receipt. Without one, a client whose PayFast return was
            // interrupted has no confirmation the payment landed and may pay again. Purely
            // a notification: a send failure must never affect the recorded payment.
            if (doc.clientEmail) {
                try {
                    const brand = await emailBrandFor(doc.accountId, doc.businessId);
                    const content = {
                        heading: `Payment received for ${doc.number}`,
                        body: [
                            `Hi ${doc.clientName},`,
                            `Thank you. We have received your payment of ${formatMoney(Number(body.amount_gross), doc.currency)} for ${doc.number}.`,
                            // Only state the standing of the invoice when we actually know it. If
                            // the balance could not be read, the payment is still recorded and
                            // confirmed above; claiming either "fully paid" or a figure we did not
                            // compute would be telling a paying client something untrue.
                            ...(bal
                                ? [settled
                                        ? 'This invoice is now fully paid.'
                                        : `The remaining balance is ${formatMoney(bal.outstanding, doc.currency)}.`]
                                : []),
                        ],
                        facts: [
                            ['Invoice', doc.number],
                            ['Paid', formatMoney(Number(body.amount_gross), doc.currency)],
                            ['Reference', pfId || 'PayFast'],
                        ],
                    };
                    await sendBusinessMail({
                        accountId: doc.accountId, businessId: doc.businessId, purpose: 'invoice',
                        to: doc.clientEmail,
                        subject: `Payment received: ${doc.number}`,
                        text: renderEmailText(brand, content),
                        html: renderEmail(brand, content),
                    });
                }
                catch { /* a receipt that fails to send must not disturb the payment */ }
            }
            req.log.info({ docId, pfId }, 'payfast payment recorded');
            await record(`Payment of ${body.amount_gross} recorded against ${doc.number}${token ? ' (card stored for auto-debit)' : ''}`, true);
            return ok();
        }
        catch (err) {
            // Everything reachable from here happens BEFORE any payment row is written, so
            // asking for the notification again is strictly safe. It used to answer 200 on
            // our own internal failure, which spent the gateway's only retry on a request
            // we had not managed to process.
            req.log.error({ err }, 'payfast ITN handler error');
            return fail();
        }
    });
}
//# sourceMappingURL=payments.js.map