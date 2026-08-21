import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, businesses, accounts } from '../db/schema.js';
import { formatMoney } from '../lib/currency.js';
import { signQuoteToken, verifyQuoteToken } from '../lib/secretbox.js';
import { appUrl } from '../lib/mailer.js';
import { rateLimit } from '../lib/rateLimit.js';
import { notifyAdmins } from '../lib/notify.js';
/**
 * The public quote page: accept or decline without an account.
 *
 * A quote used to be a PDF in an inbox; saying yes meant typing an email, and
 * every hour between "I want this" and "the business knows" is where deals cool
 * off. The emailed quote now carries a signed link (HMAC over the document id,
 * the pay-link recipe) to a page showing the quote with two buttons. A decision
 * records who typed their name, from which address, on which browser, at what
 * time: thin e-sign evidence, but exactly what you want when scope is disputed
 * months later. Decisions are final and expiry is enforced: an expired quote
 * asks for a fresh one instead of accepting silently at a stale price.
 */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shell = (title, inner) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title>`
    + `<body style="margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a">`
    + `<div style="max-width:560px;margin:6vh auto;padding:0 24px 48px">${inner}</div></body>`;
export async function quoteRoutes(app) {
    // The decision form posts urlencoded; parsers are plugin-scoped.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        const parsed = {};
        for (const pair of String(body).split('&')) {
            if (!pair)
                continue;
            const i = pair.indexOf('=');
            const k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
            const v = i === -1 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
            parsed[k] = v;
        }
        done(null, parsed);
    });
    const loadQuote = async (id) => {
        const [doc] = await db.select().from(documents)
            .where(and(eq(documents.id, id), eq(documents.type, 'quote'))).limit(1);
        return doc;
    };
    // ---- The page (PUBLIC) ---------------------------------------------------
    app.get('/api/v1/public/quote/:id', async (req, reply) => {
        const id = Number(req.params.id);
        const t = req.query.t ?? '';
        if (!id || !verifyQuoteToken(id, t))
            return reply.code(404).send({ error: 'Not found.' });
        const doc = await loadQuote(id);
        if (!doc || doc.status === 'draft' || doc.status === 'void')
            return reply.code(404).send({ error: 'Not found.' });
        const [business] = doc.businessId
            ? await db.select({ brandName: businesses.brandName, name: businesses.name }).from(businesses)
                .where(eq(businesses.id, doc.businessId)).limit(1)
            : [undefined];
        const [account] = await db.select({ brandName: accounts.brandName, name: accounts.name })
            .from(accounts).where(eq(accounts.id, doc.accountId)).limit(1);
        const brand = esc(business?.brandName || business?.name || account?.brandName || account?.name || 'Quote');
        const lines = await db.select().from(documentLines)
            .where(and(eq(documentLines.accountId, doc.accountId), eq(documentLines.documentId, id)))
            .orderBy(documentLines.position);
        const fmt = (v) => formatMoney(v, doc.currency);
        const today = new Date().toISOString().slice(0, 10);
        const expired = !!doc.dueDate && doc.dueDate < today && !doc.decision;
        const head = `<div style="font-size:13px;color:#64748b;margin-bottom:4px">${brand}</div>`
            + `<h1 style="font-size:24px;margin:0 0 2px">Quote ${esc(doc.number)}</h1>`
            + `<div style="font-size:14px;color:#64748b;margin-bottom:20px">For ${esc(doc.clientName)}`
            + (doc.dueDate ? `, valid until ${doc.dueDate}` : '') + `</div>`;
        const table = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">`
            + lines.map((l) => `<tr style="border-bottom:1px solid #e2e8f0">`
                + `<td style="padding:8px 0">${esc(l.description)}${l.detail ? `<div style="font-size:12px;color:#64748b">${esc(l.detail)}</div>` : ''}</td>`
                + `<td style="padding:8px 0;text-align:right;white-space:nowrap">${Number(l.quantity)} x ${fmt(l.unitPrice)}</td>`
                + `<td style="padding:8px 0 8px 16px;text-align:right;white-space:nowrap">${fmt(l.amount)}</td></tr>`).join('')
            + `<tr><td></td><td style="padding:10px 0;text-align:right;color:#64748b">Total</td>`
            + `<td style="padding:10px 0 10px 16px;text-align:right;font-weight:700;font-size:16px">${fmt(doc.total)}</td></tr>`
            + `</table>`
            + (doc.notes?.trim() ? `<p style="font-size:13px;color:#475569;white-space:pre-wrap">${esc(doc.notes.trim())}</p>` : '');
        let action;
        if (doc.decision) {
            const word = doc.decision === 'accepted' ? 'accepted' : 'declined';
            action = `<p style="font-weight:600;color:${doc.decision === 'accepted' ? '#16a34a' : '#dc2626'}">`
                + `This quote was ${word}${doc.decisionBy ? ` by ${esc(doc.decisionBy)}` : ''}`
                + `${doc.decisionAt ? ` on ${doc.decisionAt.toISOString().slice(0, 10)}` : ''}.</p>`;
        }
        else if (expired) {
            action = `<p style="font-weight:600;color:#d97706">This quote expired on ${doc.dueDate}. `
                + `Please ask ${brand} for a fresh one; prices may have changed.</p>`;
        }
        else {
            const post = `/api/v1/public/quote/${id}/decision?t=${esc(t)}`;
            action =
                `<form method="post" action="${post}" style="border-top:2px solid #e2e8f0;padding-top:20px">`
                    + `<label style="display:block;font-size:13px;color:#475569;margin-bottom:6px">Your full name (this records your decision)</label>`
                    + `<input name="name" required maxlength="150" placeholder="Full name" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;margin-bottom:12px">`
                    + `<div style="display:flex;gap:10px">`
                    + `<button name="decision" value="accepted" style="flex:1;padding:12px;border:0;border-radius:8px;background:#16a34a;color:#fff;font-size:15px;font-weight:600;cursor:pointer">Accept this quote</button>`
                    + `<button name="decision" value="declined" style="padding:12px 18px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#475569;font-size:15px;cursor:pointer">Decline</button>`
                    + `</div>`
                    + `<p style="font-size:11px;color:#94a3b8;margin-top:10px">By accepting you agree to the quote above. Your name, the date and your device are recorded with the decision.</p>`
                    + `</form>`;
        }
        return reply.type('text/html').send(shell(`Quote ${doc.number}`, head + table + action));
    });
    // ---- The decision (PUBLIC, rate limited) ---------------------------------
    app.post('/api/v1/public/quote/:id/decision', {
        preHandler: rateLimit({ windowMs: 5 * 60_000, max: 10, key: (req) => `quote:${req.ip}` }),
    }, async (req, reply) => {
        const id = Number(req.params.id);
        const t = req.query.t ?? '';
        if (!id || !verifyQuoteToken(id, t))
            return reply.code(404).send({ error: 'Not found.' });
        const parsed = z.object({
            decision: z.enum(['accepted', 'declined']),
            name: z.string().trim().min(2, 'Enter your full name.').max(150),
        }).safeParse(req.body ?? {});
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const doc = await loadQuote(id);
        if (!doc || doc.status !== 'sent')
            return reply.code(404).send({ error: 'That quote is not open for a decision.' });
        if (doc.decision) {
            return reply.type('text/html').send(shell('Already decided', `<h1 style="font-size:20px">This quote was already ${esc(doc.decision)}.</h1>`
                + `<p style="color:#64748b;font-size:14px">Changing a recorded decision is a conversation; please get in touch.</p>`));
        }
        const today = new Date().toISOString().slice(0, 10);
        if (doc.dueDate && doc.dueDate < today) {
            return reply.type('text/html').send(shell('Quote expired', `<h1 style="font-size:20px;color:#d97706">This quote expired on ${doc.dueDate}.</h1>`
                + `<p style="color:#64748b;font-size:14px">Please ask for a fresh quote; prices may have changed.</p>`));
        }
        const { decision, name } = parsed.data;
        const ua = String(req.headers['user-agent'] ?? '').slice(0, 255);
        const res = await db.update(documents).set({
            decision, decisionAt: new Date(), decisionBy: name,
            decisionIp: req.ip.slice(0, 64), decisionUa: ua || null,
            ...(decision === 'accepted' ? { status: 'accepted' } : {}),
        })
            // Conditional on no decision yet, so two clicks cannot both win.
            .where(and(eq(documents.id, id), eq(documents.accountId, doc.accountId), eq(documents.type, 'quote'), eq(documents.status, 'sent')));
        if (!res[0].affectedRows) {
            return reply.type('text/html').send(shell('Already decided', `<h1 style="font-size:20px">This quote was just decided elsewhere.</h1>`));
        }
        await notifyAdmins(doc.accountId, {
            kind: 'quote',
            title: `Quote ${doc.number} ${decision}`,
            body: `${name} ${decision} the ${formatMoney(doc.total, doc.currency)} quote for ${doc.clientName}.`,
            url: '/?v=billing',
        });
        const yes = decision === 'accepted';
        return reply.type('text/html').send(shell(yes ? 'Quote accepted' : 'Quote declined', `<h1 style="font-size:22px;color:${yes ? '#16a34a' : '#0f172a'}">`
            + (yes ? 'Thank you. The quote is accepted.' : 'Understood. The quote is declined.')
            + `</h1>`
            + `<p style="color:#64748b;font-size:14px">`
            + (yes ? 'The business has been told and will be in touch about next steps.' : 'The business has been told. Feedback on why is always welcome.')
            + `</p>`));
    });
    // ---- The link, for staff (authed) ----------------------------------------
    app.get('/api/v1/documents/:id/quote-link', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId } = req.auth;
        const id = Number(req.params.id);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [doc] = await db.select({ id: documents.id, type: documents.type })
            .from(documents)
            .where(and(eq(documents.accountId, accountId), eq(documents.id, id), eq(documents.type, 'quote')))
            .limit(1);
        if (!doc)
            return reply.code(404).send({ error: 'Not found.' });
        const token = signQuoteToken(id);
        if (!token)
            return reply.code(400).send({ error: 'The server has no PAYMENTS_SECRET configured, so signed public links are off.' });
        return { url: `${appUrl()}/api/v1/public/quote/${id}?t=${token}` };
    });
}
/** The public accept link for a quote, or null when signing is unavailable. */
export function quoteLinkFor(docId) {
    const token = signQuoteToken(docId);
    return token ? `${appUrl()}/api/v1/public/quote/${docId}?t=${token}` : null;
}
//# sourceMappingURL=quotes.js.map