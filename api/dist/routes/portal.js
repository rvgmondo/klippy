import { z } from 'zod';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, documentLines, payments, folders, hostingAccounts, subscriptions, portalUsers, memberships, users, events, } from '../db/schema.js';
import { appUrl, emailBrandFor, sendBusinessMail } from '../lib/mailer.js';
import { renderEmail, renderEmailText } from '../lib/emailLayout.js';
import { renderDocumentPdf } from '../lib/pdf.js';
import { credsFor } from '../lib/paymentSettings.js';
import { buildCheckout } from '../lib/payfast.js';
import { hostingSettingsFor } from '../lib/hosting.js';
import { PORTAL_COOKIE, LINK_TTL_MINUTES, consumeLoginToken, issueLoginToken, passwordLogin, portalContext, portalCookieOptions, setPortalPassword, clearPortalPassword, signPortalToken, signPreviewToken, normaliseEmail, } from '../lib/portalAuth.js';
import { authOf } from '../lib/context.js';
import { intId } from '../lib/http.js';
import { assertMaybeBusiness, assertBusinessAccess } from '../lib/access.js';
/** The scope filter. Every read of a client-owned table goes through this. */
const mine = (c) => and(eq(documents.accountId, c.user.accountId), eq(documents.folderId, c.user.folderId));
/** What a client is allowed to see at all: issued documents, never drafts. */
const VISIBLE_STATUSES = ['sent', 'paid', 'void'];
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
/** Who to tell when something happens in the portal. */
async function ownerEmail(accountId) {
    const [row] = await db.select({ email: users.email }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.accountId, accountId), eq(memberships.role, 'owner'), eq(memberships.isActive, true)))
        .limit(1);
    return row?.email ?? null;
}
async function balanceOf(accountId, docId, total) {
    const payRows = await db.select({ amount: payments.amount }).from(payments)
        .where(and(eq(payments.accountId, accountId), eq(payments.documentId, docId)));
    const paid = payRows.reduce((s, p) => s + Number(p.amount), 0);
    const creditRows = await db.select({ total: documents.total }).from(documents)
        .where(and(eq(documents.accountId, accountId), eq(documents.type, 'credit_note'), eq(documents.sourceDocumentId, docId), ne(documents.status, 'void')));
    const credited = creditRows.reduce((s, c) => s + Number(c.total), 0);
    const round = (n) => Math.round(n * 100) / 100;
    return { paid: round(paid), credited: round(credited), outstanding: round(total - paid - credited) };
}
export async function portalRoutes(app) {
    /** Resolve the caller, or answer 401. Used by everything past sign-in. */
    const require = async (req, reply) => {
        const token = req.cookies?.[PORTAL_COOKIE];
        const ctx = await portalContext(token);
        if (!ctx) {
            await reply.code(401).send({ error: 'Please sign in again.' });
            return null;
        }
        return ctx;
    };
    /**
     * Refuse a write while previewing. Returns true when the request was refused.
     *
     * Placed at the top of every mutating handler rather than relying on the UI to
     * hide buttons, because the UI is not the boundary and a preview token is a
     * perfectly ordinary cookie somebody can replay.
     */
    const blockedByPreview = async (c, reply) => {
        if (!c.preview)
            return false;
        await reply.code(403).send({
            error: 'You are previewing this portal as staff. Only the client can do that.',
        });
        return true;
    };
    const startSession = (reply, user) => {
        reply.setCookie(PORTAL_COOKIE, signPortalToken({
            pid: user.id, aid: user.accountId, fid: user.folderId, bid: user.businessId,
        }), portalCookieOptions());
    };
    // ---- Sign in --------------------------------------------------------------
    /**
     * Ask for a sign-in link.
     *
     * Always answers the same, whether or not the address is on file. Anything else
     * turns this into a way to test whether a company is a client of a competitor.
     */
    app.post('/api/v1/portal/login', async (req, reply) => {
        const parsed = z.object({ email: z.string().email().max(150) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Enter a valid email address.' });
        const issued = await issueLoginToken(parsed.data.email);
        if (issued) {
            const link = `${appUrl()}/?portal=enter&token=${encodeURIComponent(issued.raw)}`;
            const brand = await emailBrandFor(issued.user.accountId, issued.user.businessId);
            const content = {
                heading: 'Your sign-in link',
                body: [
                    `Hi ${issued.user.name || 'there'},`,
                    `Use the button below to sign in. The link works once and expires in ${LINK_TTL_MINUTES} minutes.`,
                    'If you did not ask for this, you can ignore it and nothing will happen.',
                ],
                button: { label: 'Sign in', url: link },
            };
            await sendBusinessMail({
                accountId: issued.user.accountId, businessId: issued.user.businessId,
                purpose: 'general', to: issued.user.email,
                subject: 'Your sign-in link',
                text: renderEmailText(brand, content),
                html: renderEmail(brand, content),
            }).catch(() => { });
        }
        return { ok: true, message: 'If that address is on our records, a sign-in link is on its way.' };
    });
    /** Spend a sign-in link and start a session. */
    app.post('/api/v1/portal/enter', async (req, reply) => {
        const parsed = z.object({ token: z.string().min(10).max(200) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'That link is not valid.' });
        const user = await consumeLoginToken(parsed.data.token);
        if (!user)
            return reply.code(400).send({ error: 'That link has expired or has already been used. Ask for a new one.' });
        startSession(reply, user);
        return { ok: true };
    });
    app.post('/api/v1/portal/password-login', async (req, reply) => {
        const parsed = z.object({
            email: z.string().email().max(150), password: z.string().min(1).max(200),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Enter your email and password.' });
        const user = await passwordLogin(parsed.data.email, parsed.data.password);
        // One message for both "no such address" and "wrong password", on purpose.
        if (!user)
            return reply.code(401).send({ error: 'That email and password do not match. You can also sign in by emailed link.' });
        startSession(reply, user);
        return { ok: true };
    });
    app.post('/api/v1/portal/logout', async (_req, reply) => {
        reply.clearCookie(PORTAL_COOKIE, portalCookieOptions());
        return { ok: true };
    });
    // ---- Who am I, and what does this portal look like -------------------------
    app.get('/api/v1/portal/me', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        return {
            preview: c.preview,
            user: { name: c.user.name, email: c.user.email, hasPassword: !!c.user.passwordHash },
            client: {
                name: c.client.name,
                billingEmail: c.client.billingEmail,
                vatNumber: c.client.billingVatNumber,
                address: c.client.billingAddress,
            },
            // The portal wears the business's brand, not Klippy's. A client of two of
            // these businesses should see two different-looking portals, because they are
            // dealing with two different companies.
            brand: {
                name: c.business.brandName || c.business.name,
                accent: c.business.invoiceAccent,
                fontDisplay: c.business.fontDisplay,
                fontBody: c.business.fontBody,
                hasLogo: !!c.business.logoPath,
            },
        };
    });
    /** The business logo, for the portal header. Public to the signed-in client only. */
    app.get('/api/v1/portal/logo', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        if (!c.business.logoPath)
            return reply.code(404).send({ error: 'No logo.' });
        const { createReadStream } = await import('node:fs');
        const { stat } = await import('node:fs/promises');
        const path = await import('node:path');
        const dir = process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../data/uploads');
        const full = path.join(dir, c.business.logoPath);
        try {
            await stat(full);
        }
        catch {
            return reply.code(404).send({ error: 'Image missing.' });
        }
        const ext = path.extname(full).toLowerCase();
        reply.header('Content-Type', ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/jpeg');
        reply.header('Cache-Control', 'private, max-age=300');
        return reply.send(createReadStream(full));
    });
    // ---- Documents ------------------------------------------------------------
    app.get('/api/v1/portal/documents', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        const rows = await db.select({
            id: documents.id, type: documents.type, number: documents.number,
            issueDate: documents.issueDate, dueDate: documents.dueDate, status: documents.status,
            total: documents.total, currency: documents.currency,
            decision: documents.decision, decisionAt: documents.decisionAt,
        }).from(documents)
            .where(and(mine(c), inArray(documents.status, [...VISIBLE_STATUSES])))
            .orderBy(desc(documents.issueDate), desc(documents.id))
            .limit(300);
        // Outstanding per invoice, so the portal can show what is actually still owed
        // rather than the face value of every invoice ever raised.
        const withBalance = await Promise.all(rows.map(async (r) => {
            if (r.type !== 'invoice' || r.status === 'void')
                return { ...r, outstanding: 0 };
            const b = await balanceOf(c.user.accountId, r.id, Number(r.total));
            return { ...r, outstanding: b.outstanding };
        }));
        const owed = withBalance.reduce((s, r) => s + Math.max(0, r.outstanding), 0);
        return { documents: withBalance, totalOutstanding: money(owed) };
    });
    app.get('/api/v1/portal/documents/:id', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        const id = Number(req.params.id);
        const [doc] = await db.select().from(documents)
            .where(and(mine(c), eq(documents.id, id), inArray(documents.status, [...VISIBLE_STATUSES])))
            .limit(1);
        if (!doc)
            return reply.code(404).send({ error: 'Not found.' });
        const lines = await db.select().from(documentLines)
            .where(and(eq(documentLines.accountId, c.user.accountId), eq(documentLines.documentId, id)))
            .orderBy(documentLines.position);
        const balance = await balanceOf(c.user.accountId, id, Number(doc.total));
        return { document: doc, lines, balance };
    });
    app.get('/api/v1/portal/documents/:id/pdf', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        const id = Number(req.params.id);
        // Confirm ownership BEFORE rendering. renderDocumentPdf only scopes by account,
        // so without this a client could read another client's document by id.
        const [doc] = await db.select({ id: documents.id, number: documents.number }).from(documents)
            .where(and(mine(c), eq(documents.id, id), inArray(documents.status, [...VISIBLE_STATUSES])))
            .limit(1);
        if (!doc)
            return reply.code(404).send({ error: 'Not found.' });
        const pdf = await renderDocumentPdf(c.user.accountId, id);
        if (!pdf)
            return reply.code(404).send({ error: 'Not found.' });
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `inline; filename="${pdf.filename}"`);
        return reply.send(pdf.buffer);
    });
    /** Every invoice, credit note and payment, so they can reconcile their side. */
    app.get('/api/v1/portal/statement', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        const docs = await db.select({
            id: documents.id, type: documents.type, number: documents.number,
            issueDate: documents.issueDate, total: documents.total, status: documents.status,
        }).from(documents)
            .where(and(mine(c), inArray(documents.type, ['invoice', 'credit_note']), inArray(documents.status, [...VISIBLE_STATUSES])))
            .orderBy(documents.issueDate, documents.id);
        const ids = docs.map((d) => d.id);
        const pays = ids.length
            ? await db.select({
                id: payments.id, documentId: payments.documentId, amount: payments.amount,
                paidOn: payments.paidOn, method: payments.method,
            }).from(payments)
                .where(and(eq(payments.accountId, c.user.accountId), inArray(payments.documentId, ids)))
            : [];
        let running = 0;
        const byNumber = new Map(docs.map((d) => [d.id, d.number]));
        const entries = [
            ...docs.filter((d) => d.status !== 'void').map((d) => ({
                date: d.issueDate, kind: d.type, ref: d.number,
                change: d.type === 'invoice' ? Number(d.total) : -Number(d.total),
            })),
            ...pays.map((p) => ({
                date: p.paidOn, kind: 'payment',
                ref: `${p.method ?? 'Payment'} for ${byNumber.get(p.documentId) ?? ''}`.trim(),
                change: -Number(p.amount),
            })),
        ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const lines = entries.map((e) => {
            running += e.change;
            return { ...e, change: money(e.change), balance: money(running) };
        });
        return { statement: lines, closingBalance: money(running) };
    });
    // ---- Paying ---------------------------------------------------------------
    app.post('/api/v1/portal/documents/:id/pay', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        if (await blockedByPreview(c, reply))
            return;
        const id = Number(req.params.id);
        const [doc] = await db.select().from(documents)
            .where(and(mine(c), eq(documents.id, id), eq(documents.type, 'invoice'), eq(documents.status, 'sent')))
            .limit(1);
        if (!doc)
            return reply.code(404).send({ error: 'That invoice cannot be paid.' });
        const balance = await balanceOf(c.user.accountId, id, Number(doc.total));
        if (balance.outstanding <= 0)
            return reply.code(400).send({ error: 'That invoice is already settled.' });
        // Through the invoice's own business, so the money reaches the right company.
        const creds = await credsFor(c.user.accountId, doc.businessId);
        if (!creds)
            return reply.code(400).send({ error: 'Online payment is not available for this invoice. Please use the bank details on it.' });
        const base = appUrl();
        return buildCheckout(creds, {
            // The outstanding amount, not the face value: a part-paid or part-credited
            // invoice must not ask for the whole thing again.
            amount: balance.outstanding,
            itemName: `Invoice ${doc.number}`,
            mPaymentId: `doc-${doc.id}`,
            returnUrl: `${base}/?portal=1&paid=${encodeURIComponent(doc.number)}`,
            cancelUrl: `${base}/?portal=1&cancelled=${encodeURIComponent(doc.number)}`,
            notifyUrl: `${base}/api/v1/payfast/notify`,
            buyerEmail: c.user.email,
        });
    });
    // ---- Quotes ---------------------------------------------------------------
    /**
     * Accept or decline a quote.
     *
     * Recorded with the date and who did it, because that record is the thing you
     * need when the scope of the work is argued about months later. A decision is
     * final here: changing your mind is a conversation, not a button, and letting a
     * quote flip back and forth would make the record worthless.
     */
    app.post('/api/v1/portal/quotes/:id/decision', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        if (await blockedByPreview(c, reply))
            return;
        const id = Number(req.params.id);
        const parsed = z.object({ decision: z.enum(['accepted', 'declined']) }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Choose accept or decline.' });
        const [quote] = await db.select().from(documents)
            .where(and(mine(c), eq(documents.id, id), eq(documents.type, 'quote'), eq(documents.status, 'sent')))
            .limit(1);
        if (!quote)
            return reply.code(404).send({ error: 'That quote is not available.' });
        if (quote.decision) {
            return reply.code(409).send({ error: `You already ${quote.decision} this quote. Get in touch if you need to change that.` });
        }
        const who = c.user.name || c.user.email;
        const res = await db.update(documents)
            .set({ decision: parsed.data.decision, decisionAt: new Date(), decisionBy: who })
            // Conditional on there still being no decision, so two clicks cannot both win.
            .where(and(eq(documents.id, id), eq(documents.accountId, c.user.accountId), eq(documents.folderId, c.user.folderId)));
        if (!res[0].affectedRows)
            return reply.code(409).send({ error: 'That quote was just updated. Reload and try again.' });
        // Tell the business. A quote accepted at 11pm that nobody hears about until
        // someone happens to look is a quote that loses its own momentum.
        const brand = await emailBrandFor(c.user.accountId, quote.businessId);
        const content = {
            heading: `Quote ${quote.number} ${parsed.data.decision}`,
            body: [
                `${c.client.name} has ${parsed.data.decision} quote ${quote.number}.`,
                `${who} made the decision in the client portal.`,
            ],
            facts: [
                ['Quote', quote.number],
                ['Value', `${quote.currency} ${money(Number(quote.total))}`],
            ],
        };
        const owner = await ownerEmail(c.user.accountId);
        if (owner) {
            await sendBusinessMail({
                accountId: c.user.accountId, businessId: quote.businessId, purpose: 'general',
                to: owner,
                subject: `Quote ${quote.number} ${parsed.data.decision} by ${c.client.name}`,
                text: renderEmailText(brand, content),
                html: renderEmail(brand, content),
            }).catch(() => { });
        }
        return { ok: true, decision: parsed.data.decision };
    });
    // ---- Hosting --------------------------------------------------------------
    app.get('/api/v1/portal/hosting', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        const rows = await db.select({
            id: hostingAccounts.id, domain: hostingAccounts.domain, username: hostingAccounts.username,
            whmPackage: hostingAccounts.whmPackage, status: hostingAccounts.status,
            subscriptionId: hostingAccounts.subscriptionId,
        }).from(hostingAccounts)
            .innerJoin(subscriptions, eq(subscriptions.id, hostingAccounts.subscriptionId))
            .where(and(eq(hostingAccounts.accountId, c.user.accountId), eq(subscriptions.folderId, c.user.folderId)));
        const settings = await hostingSettingsFor(c.user.accountId, c.user.businessId);
        // The control panel address, but never the server's own hostname when there is
        // nothing to show: an unconfigured portal should not leak infrastructure.
        const cpanel = settings?.whmHost ? `https://${settings.whmHost}:2083` : null;
        // What they owe on the hosting itself, which is what a suspended client needs
        // to know: how much, and paying it brings the site back.
        const withOwed = await Promise.all(rows.map(async (r) => {
            const unpaid = await db.select({ id: documents.id, number: documents.number, total: documents.total })
                .from(documents)
                .where(and(mine(c), eq(documents.subscriptionId, r.subscriptionId), eq(documents.status, 'sent')));
            let owed = 0;
            for (const u of unpaid) {
                const b = await balanceOf(c.user.accountId, u.id, Number(u.total));
                owed += Math.max(0, b.outstanding);
            }
            return {
                ...r,
                // Internal states are not the client's business: a record still being set
                // up reads as "being set up", not "pending" or "dry-run".
                display: r.status === 'active' ? 'active' : r.status === 'suspended' ? 'suspended' : 'being set up',
                outstanding: money(owed),
                unpaidInvoiceId: unpaid[0]?.id ?? null,
            };
        }));
        return { hosting: withOwed, cpanelUrl: cpanel };
    });
    // ---- Their own details ----------------------------------------------------
    app.patch('/api/v1/portal/profile', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        if (await blockedByPreview(c, reply))
            return;
        const parsed = z.object({
            name: z.string().trim().max(150).optional(),
            billingEmail: z.string().email().max(150).nullable().optional(),
            vatNumber: z.string().trim().max(60).nullable().optional(),
            address: z.string().trim().max(500).nullable().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        if (d.name !== undefined) {
            await db.update(portalUsers).set({ name: d.name }).where(eq(portalUsers.id, c.user.id));
        }
        const clientPatch = {};
        if (d.billingEmail !== undefined)
            clientPatch.billingEmail = d.billingEmail;
        if (d.vatNumber !== undefined)
            clientPatch.billingVatNumber = d.vatNumber;
        if (d.address !== undefined)
            clientPatch.billingAddress = d.address;
        if (Object.keys(clientPatch).length) {
            await db.update(folders).set(clientPatch)
                .where(and(eq(folders.id, c.user.folderId), eq(folders.accountId, c.user.accountId)));
        }
        return { ok: true };
    });
    /** Set or remove a password, for people who would rather not wait for email. */
    app.post('/api/v1/portal/password', async (req, reply) => {
        const c = await require(req, reply);
        if (!c)
            return;
        if (await blockedByPreview(c, reply))
            return;
        const parsed = z.object({ password: z.string().min(10).max(200).nullable() }).safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'A password needs to be at least 10 characters.' });
        }
        if (parsed.data.password === null)
            await clearPortalPassword(c.user.id);
        else
            await setPortalPassword(c.user.id, parsed.data.password);
        return { ok: true };
    });
}
/**
 * The staff side: giving a client access, and taking it away.
 *
 * Registered separately from the portal itself because these need a Klippy login,
 * and mixing the two auth models in one plugin is how a public route ends up behind
 * staff auth, or worse, the other way round.
 */
export async function portalAdminRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    const clientOf = async (accountId, folderId) => {
        const [f] = await db.select().from(folders)
            .where(and(eq(folders.id, folderId), eq(folders.accountId, accountId))).limit(1);
        return f ?? null;
    };
    app.get('/api/v1/folders/:id/portal-users', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const client = await clientOf(accountId, id);
        if (!client)
            return reply.code(404).send({ error: 'Client not found.' });
        if (!(await assertMaybeBusiness(req, reply, client.businessId)))
            return;
        const rows = await db.select({
            id: portalUsers.id, email: portalUsers.email, name: portalUsers.name,
            isActive: portalUsers.isActive, lastLoginAt: portalUsers.lastLoginAt,
            hasPassword: sql `${portalUsers.passwordHash} is not null`,
        }).from(portalUsers)
            .where(and(eq(portalUsers.accountId, accountId), eq(portalUsers.folderId, id)));
        return { portalUsers: rows };
    });
    app.post('/api/v1/folders/:id/portal-users', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({
            email: z.string().email().max(150),
            name: z.string().trim().max(150).optional(),
            invite: z.boolean().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const client = await clientOf(accountId, id);
        if (!client)
            return reply.code(404).send({ error: 'Client not found.' });
        if (!client.businessId) {
            return reply.code(400).send({ error: 'This client is not attached to a business yet, so there is no portal to invite them to.' });
        }
        if (!(await assertMaybeBusiness(req, reply, client.businessId)))
            return;
        const email = normaliseEmail(parsed.data.email);
        try {
            await db.insert(portalUsers).values({
                accountId, businessId: client.businessId, folderId: id,
                email, name: parsed.data.name ?? null,
            });
        }
        catch {
            return reply.code(409).send({ error: 'That address already has access to this client.' });
        }
        if (parsed.data.invite !== false)
            await sendInvite(email);
        return reply.code(201).send({ ok: true });
    });
    app.patch('/api/v1/portal-users/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Nothing to change.' });
        const res = await db.update(portalUsers).set({ isActive: parsed.data.isActive })
            .where(and(eq(portalUsers.id, id), eq(portalUsers.accountId, accountId)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Not found.' });
        return { ok: true };
    });
    app.delete('/api/v1/portal-users/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const res = await db.delete(portalUsers)
            .where(and(eq(portalUsers.id, id), eq(portalUsers.accountId, accountId)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Not found.' });
        return { ok: true };
    });
    /**
     * Start a preview of a client's portal, as staff.
     *
     * Sets the portal cookie to a short-lived read-only token. Restricted to admins
     * of the business that client belongs to, and recorded, because looking at a
     * customer's financial history is a thing that should leave a trace even when the
     * person looking is entitled to.
     */
    app.post('/api/v1/folders/:id/portal-preview', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId, userId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can preview a client portal.' });
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [client] = await db.select().from(folders)
            .where(and(eq(folders.id, id), eq(folders.accountId, accountId))).limit(1);
        if (!client)
            return reply.code(404).send({ error: 'Client not found.' });
        if (!client.businessId) {
            return reply.code(400).send({ error: 'This client is not attached to a business, so it has no portal.' });
        }
        if (!(await assertBusinessAccess(req, reply, client.businessId, 'admin')))
            return;
        await db.insert(events).values({
            accountId, businessId: client.businessId, name: 'portal.preview',
            payload: { folderId: id, clientName: client.name, byUserId: userId },
            results: [{ handler: 'portal.preview', outcome: `Previewed ${client.name}'s portal`, ok: true }],
        }).catch(() => { });
        reply.setCookie(PORTAL_COOKIE, signPreviewToken({
            aid: accountId, fid: id, bid: client.businessId,
        }), portalCookieOptions());
        return { ok: true, url: '/?portal=1' };
    });
    /** Send (or resend) a sign-in link. */
    app.post('/api/v1/portal-users/:id/invite', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [u] = await db.select().from(portalUsers)
            .where(and(eq(portalUsers.id, id), eq(portalUsers.accountId, accountId))).limit(1);
        if (!u)
            return reply.code(404).send({ error: 'Not found.' });
        if (!u.isActive)
            return reply.code(400).send({ error: 'That access is switched off. Turn it back on first.' });
        await sendInvite(u.email);
        return { ok: true };
    });
}
/** One place that builds and sends a sign-in link, so staff invites and self-service match. */
async function sendInvite(email) {
    const issued = await issueLoginToken(email);
    if (!issued)
        return;
    const link = `${appUrl()}/?portal=enter&token=${encodeURIComponent(issued.raw)}`;
    const brand = await emailBrandFor(issued.user.accountId, issued.user.businessId);
    const content = {
        heading: 'Your account is ready',
        body: [
            `Hi ${issued.user.name || 'there'},`,
            'You can now see your invoices, quotes and account online, and pay outstanding invoices.',
            `This link signs you in once and expires in ${LINK_TTL_MINUTES} minutes. You can ask for a new one any time from the sign-in page.`,
        ],
        button: { label: 'Open your account', url: link },
    };
    await sendBusinessMail({
        accountId: issued.user.accountId, businessId: issued.user.businessId,
        purpose: 'general', to: issued.user.email,
        subject: 'Your account is ready',
        text: renderEmailText(brand, content),
        html: renderEmail(brand, content),
    }).catch(() => { });
}
//# sourceMappingURL=portal.js.map