import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { money } from '../lib/money.js';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { DEFAULT_CURRENCY, formatMoney, payfastSupports } from '../lib/currency.js';
import { db } from '../db/client.js';
import {
  documents, documentLines, payments, folders, hostingAccounts, subscriptions, portalUsers,
  memberships, users, events, offerings, boards, tasks, timeEntries,
} from '../db/schema.js';
import { appUrl, emailBrandFor, sendBusinessMail } from '../lib/mailer.js';
import { renderEmail, renderEmailText } from '../lib/emailLayout.js';
import { renderDocumentPdf } from '../lib/pdf.js';
import { credsFor } from '../lib/paymentSettings.js';
import { buildCheckout } from '../lib/payfast.js';
import { hostingSettingsFor, provisionSubscription, switchToRealDomain, cleanDomain } from '../lib/hosting.js';
import { balanceOf, balancesFor } from '../lib/balances.js';
import { isDuplicateKey } from '../lib/tenant.js';
import {
  PORTAL_COOKIE, LINK_TTL_MINUTES, consumeLoginToken, issueLoginToken, passwordLogin, portalContext, portalCookieOptions, setPortalPassword, clearPortalPassword, signPortalToken, signPreviewToken, normaliseEmail, type PortalContext, generatePortalPassword,
} from '../lib/portalAuth.js';
import { authOf } from '../lib/context.js';
import { intId } from '../lib/http.js';
import { assertMaybeBusiness, assertBusinessAccess } from '../lib/access.js';
import { authLimiter } from '../lib/rateLimit.js';
import { notifyAdmins } from '../lib/notify.js';

/**
 * The client portal: the only part of Klippy a stranger can reach.
 *
 * Two rules run through every handler here.
 *
 * First, scope. Every query is filtered by the signed-in client's accountId AND
 * their folderId. Not one or the other. A bug that dropped the folder filter would
 * show one client another client's invoices, which is the worst thing this codebase
 * could do, so the filter is applied in `mine()` rather than written out by hand at
 * each call site.
 *
 * Second, drafts are invisible. A draft is a document you are still thinking about;
 * showing a client a half-finished invoice, or a quote at a price you have not
 * settled on, is worse than showing them nothing.
 */

type Ctx = PortalContext;

/** The scope filter. Every read of a client-owned table goes through this. */
const mine = (c: Ctx) => and(
  eq(documents.accountId, c.user.accountId),
  eq(documents.folderId, c.user.folderId),
);

/** What a client is allowed to see at all: issued documents, never drafts. */
const VISIBLE_STATUSES = ['sent', 'paid', 'void'] as const;


/** Who to tell when something happens in the portal. */
async function ownerEmail(accountId: number): Promise<string | null> {
  const [row] = await db.select({ email: users.email }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.accountId, accountId), eq(memberships.role, 'owner'),
      eq(memberships.isActive, true)))
    .limit(1);
  return row?.email ?? null;
}


export async function portalRoutes(app: FastifyInstance) {
  /** Resolve the caller, or answer 401. Used by everything past sign-in. */
  const require = async (req: FastifyRequest, reply: FastifyReply): Promise<Ctx | null> => {
    const token = (req.cookies as Record<string, string> | undefined)?.[PORTAL_COOKIE];
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
  const blockedByPreview = async (c: Ctx, reply: FastifyReply): Promise<boolean> => {
    if (!c.preview) return false;
    await reply.code(403).send({
      error: 'You are previewing this portal as staff. Only the client can do that.',
    });
    return true;
  };

  const startSession = (reply: FastifyReply, user: typeof portalUsers.$inferSelect) => {
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
  app.post('/api/v1/portal/login', { preHandler: authLimiter('portal-login') }, async (req, reply) => {
    const parsed = z.object({ email: z.string().email().max(150) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a valid email address.' });

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
      }).catch(() => { /* never let a mail failure reveal that the address exists */ });
    }
    return { ok: true, message: 'If that address is on our records, a sign-in link is on its way.' };
  });

  /** Spend a sign-in link and start a session. */
  app.post('/api/v1/portal/enter', async (req, reply) => {
    const parsed = z.object({ token: z.string().min(10).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'That link is not valid.' });
    const user = await consumeLoginToken(parsed.data.token);
    if (!user) return reply.code(400).send({ error: 'That link has expired or has already been used. Ask for a new one.' });
    startSession(reply, user);
    return { ok: true };
  });

  app.post('/api/v1/portal/password-login', { preHandler: authLimiter('portal-password-login') }, async (req, reply) => {
    const parsed = z.object({
      email: z.string().email().max(150), password: z.string().min(1).max(200),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter your email and password.' });
    const user = await passwordLogin(parsed.data.email, parsed.data.password);
    // One message for both "no such address" and "wrong password", on purpose.
    if (!user) return reply.code(401).send({ error: 'That email and password do not match. You can also sign in by emailed link.' });
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
    if (!c) return;
    return {
      preview: c.preview,
      user: { name: c.user.name, email: c.user.email, hasPassword: !!c.user.passwordHash },
      client: {
        name: c.client.name,
        billingEmail: c.client.billingEmail,
        phone: c.client.billingPhone,
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
    if (!c) return;
    if (!c.business.logoPath) return reply.code(404).send({ error: 'No logo.' });
    const { createReadStream } = await import('node:fs');
    const { stat } = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../data/uploads');
    const full = path.join(dir, c.business.logoPath);
    try { await stat(full); } catch { return reply.code(404).send({ error: 'Image missing.' }); }
    const ext = path.extname(full).toLowerCase();
    reply.header('Content-Type', ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'image/jpeg');
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(createReadStream(full));
  });

  // ---- Documents ------------------------------------------------------------
  app.get('/api/v1/portal/documents', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
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
    // rather than the face value of every invoice ever raised. Batched: this used
    // to run two queries per row, so a client with a hundred invoices paid for the
    // page with two hundred round trips.
    const billable = rows.filter((r) => r.type === 'invoice' && r.status !== 'void');
    const balances = await balancesFor(c.user.accountId, billable);
    const withBalance = rows.map((r) => ({
      ...r,
      outstanding: r.type === 'invoice' && r.status !== 'void'
        ? (balances.get(r.id)?.outstanding ?? Number(r.total))
        : 0,
    }));
    // Per currency, because this number is shown to a paying client. A client
    // billed in two currencies used to be told they owed the sum of both, labelled
    // with whichever happened to be first in the list.
    const owedBy = new Map<string, number>();
    for (const r of withBalance) {
      if (r.outstanding > 0) owedBy.set(r.currency, (owedBy.get(r.currency) ?? 0) + r.outstanding);
    }
    const outstanding = [...owedBy]
      .map(([currency, amount]) => ({ currency, amount: money(amount) }))
      .sort((a, b) => Number(b.amount) - Number(a.amount));
    return { documents: withBalance, outstanding };
  });

  app.get('/api/v1/portal/documents/:id', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    const id = Number((req.params as { id: string }).id);
    const [doc] = await db.select().from(documents)
      .where(and(mine(c), eq(documents.id, id), inArray(documents.status, [...VISIBLE_STATUSES])))
      .limit(1);
    if (!doc) return reply.code(404).send({ error: 'Not found.' });
    const lines = await db.select().from(documentLines)
      .where(and(eq(documentLines.accountId, c.user.accountId), eq(documentLines.documentId, id)))
      .orderBy(documentLines.position);
    const balance = await balanceOf(c.user.accountId, id, Number(doc.total));
    return { document: doc, lines, balance };
  });

  app.get('/api/v1/portal/documents/:id/pdf', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    const id = Number((req.params as { id: string }).id);
    // Confirm ownership BEFORE rendering. renderDocumentPdf only scopes by account,
    // so without this a client could read another client's document by id.
    const [doc] = await db.select({ id: documents.id, number: documents.number }).from(documents)
      .where(and(mine(c), eq(documents.id, id), inArray(documents.status, [...VISIBLE_STATUSES])))
      .limit(1);
    if (!doc) return reply.code(404).send({ error: 'Not found.' });
    const pdf = await renderDocumentPdf(c.user.accountId, id);
    if (!pdf) return reply.code(404).send({ error: 'Not found.' });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="${pdf.filename}"`);
    return reply.send(pdf.buffer);
  });

  /** Every invoice, credit note and payment, so they can reconcile their side. */
  app.get('/api/v1/portal/statement', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    const allDocs = await db.select({
      id: documents.id, type: documents.type, number: documents.number,
      issueDate: documents.issueDate, total: documents.total, status: documents.status,
      currency: documents.currency,
    }).from(documents)
      .where(and(mine(c), inArray(documents.type, ['invoice', 'credit_note']),
        inArray(documents.status, [...VISIBLE_STATUSES])))
      .orderBy(documents.issueDate, documents.id);

    // A running balance only means something within ONE currency. Pick the most
    // recent currency by default (or an asked-for one), and tell the client which
    // others exist, so a client billed in two is never shown their sum.
    const currencies = [...new Set(allDocs.map((d) => d.currency))].sort();
    const wanted = (req.query as { currency?: string }).currency?.toUpperCase();
    const latest = allDocs.reduce<typeof allDocs[number] | undefined>(
      (best, d) => (!best || d.issueDate > best.issueDate ? d : best), undefined);
    const currency = (wanted && currencies.includes(wanted)) ? wanted : (latest?.currency ?? 'ZAR');
    const docs = allDocs.filter((d) => d.currency === currency);

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
        date: p.paidOn, kind: 'payment' as const,
        ref: `${p.method ?? 'Payment'} for ${byNumber.get(p.documentId) ?? ''}`.trim(),
        change: -Number(p.amount),
      })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const lines = entries.map((e) => {
      running += e.change;
      return { ...e, change: money(e.change), balance: money(running) };
    });
    return { statement: lines, closingBalance: money(running), currency, currencies };
  });

  // ---- Paying ---------------------------------------------------------------
  app.post('/api/v1/portal/documents/:id/pay', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    if (await blockedByPreview(c, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const [doc] = await db.select().from(documents)
      .where(and(mine(c), eq(documents.id, id), eq(documents.type, 'invoice'), eq(documents.status, 'sent')))
      .limit(1);
    if (!doc) return reply.code(404).send({ error: 'That invoice cannot be paid.' });

    const balance = await balanceOf(c.user.accountId, id, Number(doc.total));
    if (balance.outstanding <= 0) return reply.code(400).send({ error: 'That invoice is already settled.' });

    // Through the invoice's own business, so the money reaches the right company.
    const creds = await credsFor(c.user.accountId, doc.businessId, doc.currency);
    if (!creds) {
      return reply.code(400).send({
        error: payfastSupports(doc.currency)
          ? 'Online payment is not available for this invoice. Please use the bank details on it.'
          : `Invoices in ${doc.currency} cannot be paid by card here. Please use the bank details on the invoice.`,
      });
    }

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
  /**
   * What did we actually do for you this month?
   *
   * The client-facing answer to the invoice: cards finished and hours worked on
   * their boards, by month. Businesses send this by hand today (or worse, do not,
   * and field the "what am I paying for?" call instead). Read-only, from data the
   * timers and boards already hold.
   */
  app.get('/api/v1/portal/report', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Bad month.' });
    const month = q.data.month ?? new Date().toISOString().slice(0, 7);
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));

    // The client's whole subtree, same rollup as everywhere else.
    const allFolders = await db.select({ id: folders.id, parentId: folders.parentId })
      .from(folders).where(eq(folders.accountId, c.user.accountId));
    const subtree = new Set<number>([c.user.folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of allFolders) {
        if (f.parentId != null && subtree.has(f.parentId) && !subtree.has(f.id)) { subtree.add(f.id); grew = true; }
      }
    }
    const boardRows = await db.select({ id: boards.id, name: boards.name }).from(boards)
      .where(and(eq(boards.accountId, c.user.accountId),
        inArray(boards.folderId, [...subtree]), isNull(boards.deletedAt)));
    if (!boardRows.length) return { month, boards: [], completed: [], totalHours: 0 };
    const boardIds = boardRows.map((b) => b.id);
    const nameOf = new Map(boardRows.map((b) => [b.id, b.name]));

    const time = await db.select({
      boardId: tasks.boardId,
      seconds: sql<number>`COALESCE(SUM(${timeEntries.durationSeconds}),0)`,
    }).from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(and(eq(timeEntries.accountId, c.user.accountId),
        inArray(tasks.boardId, boardIds),
        gte(timeEntries.startTime, start), lt(timeEntries.startTime, end)))
      .groupBy(tasks.boardId);

    const done = await db.select({
      id: tasks.id, title: tasks.title, completedAt: tasks.completedAt, boardId: tasks.boardId,
    }).from(tasks)
      .where(and(eq(tasks.accountId, c.user.accountId),
        inArray(tasks.boardId, boardIds), eq(tasks.isCompleted, true),
        gte(tasks.completedAt, start), lt(tasks.completedAt, end)))
      .orderBy(desc(tasks.completedAt))
      .limit(100);

    const hoursOf = (secs: number) => Math.round((secs / 3600) * 10) / 10;
    const boardsOut = time
      .map((t) => ({ name: nameOf.get(t.boardId) ?? 'Work', hours: hoursOf(Number(t.seconds)) }))
      .filter((b) => b.hours > 0)
      .sort((a, b) => b.hours - a.hours);
    return {
      month,
      boards: boardsOut,
      completed: done.map((d) => ({
        title: d.title,
        on: d.completedAt?.toISOString().slice(0, 10) ?? null,
        board: nameOf.get(d.boardId) ?? null,
      })),
      totalHours: hoursOf(time.reduce((s2, t) => s2 + Number(t.seconds), 0)),
    };
  });

  app.post('/api/v1/portal/quotes/:id/decision', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    if (await blockedByPreview(c, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ decision: z.enum(['accepted', 'declined']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Choose accept or decline.' });

    const [quote] = await db.select().from(documents)
      .where(and(mine(c), eq(documents.id, id), eq(documents.type, 'quote'), eq(documents.status, 'sent')))
      .limit(1);
    if (!quote) return reply.code(404).send({ error: 'That quote is not available.' });
    if (quote.decision) {
      return reply.code(409).send({ error: `You already ${quote.decision} this quote. Get in touch if you need to change that.` });
    }
    // An expired quote is not silently acceptable at a stale price.
    const todayStr = new Date().toISOString().slice(0, 10);
    if (quote.dueDate && quote.dueDate < todayStr) {
      return reply.code(409).send({ error: `This quote expired on ${quote.dueDate}. Please ask for a fresh one.` });
    }

    const who = c.user.name || c.user.email;
    const res = await db.update(documents)
      .set({ decision: parsed.data.decision, decisionAt: new Date(), decisionBy: who })
      // Conditional on there still being no decision, so two clicks cannot both win.
      .where(and(eq(documents.id, id), eq(documents.accountId, c.user.accountId),
        eq(documents.folderId, c.user.folderId)));
    if (!res[0].affectedRows) return reply.code(409).send({ error: 'That quote was just updated. Reload and try again.' });

    // Tell the business. A quote accepted at 11pm that nobody hears about until
    // someone happens to look is a quote that loses its own momentum.
    await notifyAdmins(c.user.accountId, {
      kind: 'quote',
      title: `Quote ${quote.number} ${parsed.data.decision}`,
      body: `${who} ${parsed.data.decision} the quote for ${c.client.name} in the portal.`,
      url: '/?v=billing',
    });

    const brand = await emailBrandFor(c.user.accountId, quote.businessId);
    const content = {
      heading: `Quote ${quote.number} ${parsed.data.decision}`,
      body: [
        `${c.client.name} has ${parsed.data.decision} quote ${quote.number}.`,
        `${who} made the decision in the client portal.`,
      ],
      facts: [
        ['Quote', quote.number] as [string, string],
        ['Value', formatMoney(Number(quote.total), quote.currency)] as [string, string],
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
      }).catch(() => { /* the decision is recorded either way */ });
    }

    return { ok: true, decision: parsed.data.decision };
  });

  // ---- Hosting --------------------------------------------------------------
  app.get('/api/v1/portal/hosting', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    const rows = await db.select({
      id: hostingAccounts.id, domain: hostingAccounts.domain, username: hostingAccounts.username,
      whmPackage: hostingAccounts.whmPackage, status: hostingAccounts.status,
      subscriptionId: hostingAccounts.subscriptionId,
      isTemporary: hostingAccounts.isTemporary, tempDomain: hostingAccounts.tempDomain,
    }).from(hostingAccounts)
      .innerJoin(subscriptions, eq(subscriptions.id, hostingAccounts.subscriptionId))
      .where(and(
        eq(hostingAccounts.accountId, c.user.accountId),
        eq(subscriptions.folderId, c.user.folderId),
      ));

    const settings = await hostingSettingsFor(c.user.accountId, c.user.businessId);
    // The control panel is reached through the SITE's own address (cPanel proxies
    // /cpanel to the panel), so the link is the domain the client knows: their own
    // once connected, the holding address before then. The server's direct :2083
    // address rides along as the fallback for the gap while DNS still points
    // elsewhere; it is only exposed when hosting is actually configured.
    const serverCpanel = settings?.whmHost ? `https://${settings.whmHost}:2083` : null;
    const cpanel = serverCpanel;

    // What they owe on the hosting itself, which is what a suspended client needs
    // to know: how much, and paying it brings the site back.
    // Every unpaid invoice across every one of their hosting subscriptions, in one
    // query, then the balances in two more. Previously this was a query per
    // subscription plus two per invoice underneath it.
    // Filter nulls: a hosting row can outlive its subscription (FK set-null on delete).
    const subIds = rows.map((r) => r.subscriptionId).filter((n): n is number => n != null);
    const unpaidAll = subIds.length
      ? await db.select({
        id: documents.id, number: documents.number, total: documents.total,
        subscriptionId: documents.subscriptionId, currency: documents.currency,
      }).from(documents)
        .where(and(mine(c), inArray(documents.subscriptionId, subIds), eq(documents.status, 'sent')))
      : [];
    const unpaidBalances = await balancesFor(c.user.accountId, unpaidAll);

    const withOwed = rows.map((r) => {
      const unpaid = unpaidAll.filter((u) => u.subscriptionId === r.subscriptionId);
      let owed = 0;
      for (const u of unpaid) {
        owed += Math.max(0, unpaidBalances.get(u.id)?.outstanding ?? Number(u.total));
      }
      // The address the client should use, and whether it is the holding one.
      const cpanelUrl = `https://${r.domain}/cpanel`;
      return {
        cpanelUrl,
        ...r,
        // Internal states are not the client's business: a record still being set
        // up reads as "being set up", not "pending" or "dry-run".
        display: r.status === 'active' ? 'active' : r.status === 'suspended' ? 'suspended' : 'being set up',
        outstanding: money(owed),
        // From the invoice that is actually owed, not a guess. The portal used to
        // print a rand sign here whatever the invoice said.
        currency: unpaid[0]?.currency ?? DEFAULT_CURRENCY,
        unpaidInvoiceId: unpaid[0]?.id ?? null,
      };
    });
    return { hosting: withOwed, cpanelUrl: cpanel };
  });


  /**
   * Tell us the domain. This is the other half of selling hosting.
   *
   * Klippy cannot know what domain a client bought hosting for, because only they
   * know. So when hosting is paid for without one, they are asked, and this is
   * where the answer lands. Provisioning runs immediately on a good answer rather
   * than waiting for a nightly sweep, because they are watching the screen.
   */
  app.post('/api/v1/portal/hosting/:id/domain', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    if (await blockedByPreview(c, reply)) return;
    const subscriptionId = Number((req.params as { id: string }).id);
    const parsed = z.object({ domain: z.string().trim().min(3).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the domain you want hosted.' });

    const clean = cleanDomain(parsed.data.domain);
    if (!clean) {
      return reply.code(400).send({ error: 'That does not look like a domain. Enter it like yourbusiness.co.za, with no http or www.' });
    }

    const [sub] = await db.select().from(subscriptions)
      .where(and(
        eq(subscriptions.accountId, c.user.accountId),
        eq(subscriptions.id, subscriptionId),
        // Their own subscription, not any subscription with that id.
        eq(subscriptions.folderId, c.user.folderId),
      )).limit(1);
    if (!sub) return reply.code(404).send({ error: 'Not found.' });
    if (sub.domain) return reply.code(409).send({ error: 'A domain is already set. Get in touch if it needs changing.' });

    await db.update(subscriptions).set({ domain: clean })
      .where(and(eq(subscriptions.accountId, c.user.accountId), eq(subscriptions.id, subscriptionId)));

    // Two different jobs depending on where they are. Somebody already building on
    // a holding address needs their account MOVED; somebody with nothing yet needs
    // it created. Doing the wrong one either strands them or makes a second account.
    const [existing] = await db.select({ isTemporary: hostingAccounts.isTemporary })
      .from(hostingAccounts)
      .where(and(
        eq(hostingAccounts.accountId, c.user.accountId),
        eq(hostingAccounts.subscriptionId, subscriptionId),
      )).limit(1);

    if (existing?.isTemporary) {
      const moved = await switchToRealDomain(c.user.accountId, subscriptionId, clean);
      return { ok: moved.ok, domain: clean, message: moved.message };
    }

    const res = await provisionSubscription(c.user.accountId, subscriptionId);
    return {
      ok: true, domain: clean,
      // Said plainly, because they are waiting: either it is up, or somebody will
      // finish it by hand. Never a raw outcome word.
      message: res.outcome === 'created'
        ? 'Your hosting is being set up now. Your login details are on their way by email.'
        : 'Thank you. We have got your domain and will have your hosting ready shortly.',
    };
  });

  /** Subscriptions of theirs that are paid for but waiting on a domain. */
  app.get('/api/v1/portal/hosting/awaiting', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    const rows = await db.select({
      id: subscriptions.id, offeringName: offerings.name,
    }).from(subscriptions)
      .innerJoin(offerings, eq(offerings.id, subscriptions.offeringId))
      .where(and(
        eq(subscriptions.accountId, c.user.accountId),
        eq(subscriptions.folderId, c.user.folderId),
        eq(subscriptions.status, 'active'),
        eq(offerings.provisioning, 'cpanel'),
        isNull(subscriptions.domain),
      ));
    // Whether they are already up on a holding address changes what we say to them:
    // "we cannot set you up yet" is wrong for somebody whose site is already live.
    const ids = rows.map((r) => r.id);
    const accounts = ids.length
      ? await db.select({
        subscriptionId: hostingAccounts.subscriptionId,
        domain: hostingAccounts.domain, isTemporary: hostingAccounts.isTemporary,
      }).from(hostingAccounts)
        .where(and(
          eq(hostingAccounts.accountId, c.user.accountId),
          inArray(hostingAccounts.subscriptionId, ids),
        ))
      : [];
    const bySub = new Map(accounts.map((a) => [a.subscriptionId, a]));
    const withState = rows.map((r) => {
      const h = bySub.get(r.id);
      return { ...r, onHoldingAddress: !!h?.isTemporary, holdingDomain: h?.isTemporary ? h.domain : null };
    });
    return { awaiting: withState };
  });

  // ---- Their own details ----------------------------------------------------
  app.patch('/api/v1/portal/profile', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    if (await blockedByPreview(c, reply)) return;
    const parsed = z.object({
      name: z.string().trim().max(150).optional(),
      billingEmail: z.string().email().max(150).nullable().optional(),
      vatNumber: z.string().trim().max(60).nullable().optional(),
      address: z.string().trim().max(500).nullable().optional(),
      phone: z.string().trim().max(40).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    if (d.name !== undefined) {
      await db.update(portalUsers).set({ name: d.name }).where(eq(portalUsers.id, c.user.id));
    }
    const clientPatch: Record<string, unknown> = {};
    if (d.billingEmail !== undefined) clientPatch.billingEmail = d.billingEmail;
    if (d.vatNumber !== undefined) clientPatch.billingVatNumber = d.vatNumber;
    if (d.address !== undefined) clientPatch.billingAddress = d.address;
    if (d.phone !== undefined) clientPatch.billingPhone = d.phone?.trim() || null;
    if (Object.keys(clientPatch).length) {
      await db.update(folders).set(clientPatch)
        .where(and(eq(folders.id, c.user.folderId), eq(folders.accountId, c.user.accountId)));
    }
    return { ok: true };
  });

  /** Set or remove a password, for people who would rather not wait for email. */
  app.post('/api/v1/portal/password', async (req, reply) => {
    const c = await require(req, reply);
    if (!c) return;
    if (await blockedByPreview(c, reply)) return;
    const parsed = z.object({ password: z.string().min(10).max(200).nullable() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A password needs to be at least 10 characters.' });
    }
    if (parsed.data.password === null) await clearPortalPassword(c.user.id);
    else await setPortalPassword(c.user.id, parsed.data.password);
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
export async function portalAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  const clientOf = async (accountId: number, folderId: number) => {
    const [f] = await db.select().from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.accountId, accountId))).limit(1);
    return f ?? null;
  };

  app.get('/api/v1/folders/:id/portal-users', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const client = await clientOf(accountId, id);
    if (!client) return reply.code(404).send({ error: 'Client not found.' });
    if (!(await assertMaybeBusiness(req, reply, client.businessId))) return;
    const rows = await db.select({
      id: portalUsers.id, email: portalUsers.email, name: portalUsers.name,
      isActive: portalUsers.isActive, lastLoginAt: portalUsers.lastLoginAt,
      // MySQL answers a null-check with 1/0, not true/false, so it is normalised
      // here rather than leaving every caller to rely on truthiness. The password
      // itself is never selected: only whether one exists.
      hasPassword: sql<number>`${portalUsers.passwordHash} is not null`,
    }).from(portalUsers)
      .where(and(eq(portalUsers.accountId, accountId), eq(portalUsers.folderId, id)));
    return { portalUsers: rows.map((r) => ({ ...r, hasPassword: !!Number(r.hasPassword) })) };
  });

  app.post('/api/v1/folders/:id/portal-users', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      email: z.string().email().max(150),
      name: z.string().trim().max(150).optional(),
      invite: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const client = await clientOf(accountId, id);
    if (!client) return reply.code(404).send({ error: 'Client not found.' });
    if (!client.businessId) {
      return reply.code(400).send({ error: 'This client is not attached to a business yet, so there is no portal to invite them to.' });
    }
    if (!(await assertMaybeBusiness(req, reply, client.businessId))) return;

    const email = normaliseEmail(parsed.data.email);
    try {
      await db.insert(portalUsers).values({
        accountId, businessId: client.businessId, folderId: id,
        email, name: parsed.data.name ?? null,
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        return reply.code(409).send({ error: 'That address already has access to this client.' });
      }
      return reply.code(500).send({ error: 'Could not add that person. Try again.' });
    }
    if (parsed.data.invite !== false) await sendInvite(email);
    return reply.code(201).send({ ok: true });
  });

  app.patch('/api/v1/portal-users/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Nothing to change.' });
    const res = await db.update(portalUsers).set({ isActive: parsed.data.isActive })
      .where(and(eq(portalUsers.id, id), eq(portalUsers.accountId, accountId)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
    return { ok: true };
  });

  app.delete('/api/v1/portal-users/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const res = await db.delete(portalUsers)
      .where(and(eq(portalUsers.id, id), eq(portalUsers.accountId, accountId)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Not found.' });
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
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can preview a client portal.' });
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });

    const [client] = await db.select().from(folders)
      .where(and(eq(folders.id, id), eq(folders.accountId, accountId))).limit(1);
    if (!client) return reply.code(404).send({ error: 'Client not found.' });
    if (!client.businessId) {
      return reply.code(400).send({ error: 'This client is not attached to a business, so it has no portal.' });
    }
    if (!(await assertBusinessAccess(req, reply, client.businessId, 'admin'))) return;

    await db.insert(events).values({
      accountId, businessId: client.businessId, name: 'portal.preview',
      payload: { folderId: id, clientName: client.name, byUserId: userId },
      results: [{ handler: 'portal.preview', outcome: `Previewed ${client.name}'s portal`, ok: true }],
    }).catch(() => { /* the preview is not worth failing over a log write */ });

    reply.setCookie(PORTAL_COOKIE, signPreviewToken({
      aid: accountId, fid: id, bid: client.businessId,
    }), portalCookieOptions());
    return { ok: true, url: '/?portal=1' };
  });


  /**
   * Set or clear a client's portal password, as staff.
   *
   * Deliberately SET, never reveal: portal passwords are bcrypt-hashed, so no
   * screen anywhere in Klippy can show an existing one, and building a way to
   * would mean storing them recoverably. What an admin actually needs when a
   * client says "I cannot get in" is a working credential to hand over, so this
   * generates a strong one (or takes one you choose), shows it back ONCE, and
   * emails the client their sign-in link alongside it when asked.
   *
   * Clearing it is the other half: the client goes back to one-click sign-in
   * links, which is how the portal works by default.
   */
  app.post('/api/v1/portal-users/:id/password', async (req, reply) => {
    const { accountId, userId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can change portal access.' });
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      /** Omit to generate one. Explicit null clears it back to link-only sign-in. */
      password: z.string().min(10, 'A password needs to be at least 10 characters.').max(200).nullable().optional(),
      /** Also send them a fresh sign-in link, so they have a way in either way. */
      sendLink: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [u] = await db.select().from(portalUsers)
      .where(and(eq(portalUsers.id, id), eq(portalUsers.accountId, accountId))).limit(1);
    if (!u) return reply.code(404).send({ error: 'Not found.' });

    const record = async (outcome: string) => {
      await db.insert(events).values({
        accountId, businessId: u.businessId, name: 'portal.access',
        payload: { portalUserId: id, email: u.email, byUserId: userId },
        results: [{ handler: 'portal.password', outcome, ok: true }],
      }).catch(() => { /* never fail the change over a log write */ });
    };

    if (parsed.data.password === null) {
      await clearPortalPassword(id);
      await record(`Cleared the portal password for ${u.email}; sign-in links only.`);
      return { ok: true, cleared: true };
    }

    // Generated by default: an admin inventing "Password123" for a client is worse
    // than one they never have to remember.
    const password = parsed.data.password ?? generatePortalPassword();
    await setPortalPassword(id, password);
    let linkSent = false;
    if (parsed.data.sendLink && u.isActive) {
      await sendInvite(u.email).then(() => { linkSent = true; }).catch(() => { /* password still stands */ });
    }
    await record(`Set a new portal password for ${u.email}${linkSent ? ' and sent a sign-in link' : ''}.`);
    return { ok: true, password, email: u.email, linkSent };
  });

  /** Send (or resend) a sign-in link. */
  app.post('/api/v1/portal-users/:id/invite', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [u] = await db.select().from(portalUsers)
      .where(and(eq(portalUsers.id, id), eq(portalUsers.accountId, accountId))).limit(1);
    if (!u) return reply.code(404).send({ error: 'Not found.' });
    if (!u.isActive) return reply.code(400).send({ error: 'That access is switched off. Turn it back on first.' });
    await sendInvite(u.email);
    return { ok: true };
  });
}

/** One place that builds and sends a sign-in link, so staff invites and self-service match. */
async function sendInvite(email: string): Promise<void> {
  const issued = await issueLoginToken(email);
  if (!issued) return;
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
  }).catch(() => { /* the login still exists; the link can be resent */ });
}
