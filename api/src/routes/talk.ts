import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  folders, clientEmails, supportRequests, supportMessages, portalUsers, users, businesses,
} from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { intId } from '../lib/http.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { canSeeBusiness, businessScope } from '../lib/access.js';
import { appUrl, emailBrandFor, sendBusinessMail } from '../lib/mailer.js';
import { renderEmail, renderEmailText } from '../lib/emailLayout.js';

/**
 * Talking to clients from inside Klippy: writing them an email, and answering the
 * help requests they send from their portal.
 *
 * Both are about one client, so both start by loading that client and checking the
 * person asking can see its business. Nothing here takes a client id on trust.
 */

const EMAIL = z.string().trim().email().max(150);
const paragraphs = (s: string) => s.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/** Load a client this person may see, or answer 404. */
async function clientFor(req: FastifyRequest, reply: FastifyReply, id: number) {
  const { accountId } = authOf(req);
  const [f] = await db.select({
    id: folders.id, name: folders.name, businessId: folders.businessId, billingEmail: folders.billingEmail,
  }).from(folders).where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
  if (!f || (f.businessId != null && !(await canSeeBusiness(req, f.businessId)))) {
    await reply.code(404).send({ error: 'That client is not here.' });
    return null;
  }
  return f;
}

export async function talkRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ---- Emails to a client ----------------------------------------------------------

  app.get('/api/v1/clients/:id/emails', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const f = await clientFor(req, reply, id);
    if (!f) return;
    const rows = await db.select({
      id: clientEmails.id, to: clientEmails.toEmails, subject: clientEmails.subject, body: clientEmails.body,
      status: clientEmails.status, error: clientEmails.error, createdAt: clientEmails.createdAt, by: users.name,
    }).from(clientEmails).leftJoin(users, eq(users.id, clientEmails.sentBy))
      .where(tenantWhere(clientEmails, accountId, eq(clientEmails.folderId, f.id)))
      .orderBy(desc(clientEmails.createdAt)).limit(100);
    return { emails: rows };
  });

  app.post('/api/v1/clients/:id/emails', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      to: z.array(EMAIL).min(1).max(10),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(20000),
    }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Add who it goes to, a subject and a message. Check the email addresses are right.' });
    }
    const f = await clientFor(req, reply, id);
    if (!f) return;
    const { to, subject, body } = parsed.data;
    const recipients = [...new Set(to.map((e) => e.toLowerCase()))];

    const brand = await emailBrandFor(accountId, f.businessId);
    const content = { heading: '', body: paragraphs(body) };
    let error: string | null = null;
    for (const addr of recipients) {
      try {
        await sendBusinessMail({
          accountId, businessId: f.businessId, purpose: 'general', to: addr, subject,
          text: renderEmailText(brand, content), html: renderEmail(brand, content),
        });
      } catch (err) {
        req.log.warn({ err }, 'client email failed');
        error = 'The email server would not take it. Check the email settings for this business.';
      }
    }
    const ins = await db.insert(clientEmails).values(withTenant(accountId, {
      businessId: f.businessId, folderId: f.id, toEmails: recipients.join(', ').slice(0, 500),
      subject, body, status: error ? 'failed' as const : 'sent' as const, error, sentBy: userId,
    }));
    if (error) return reply.code(502).send({ error, id: Number(ins[0].insertId) });
    return { ok: true, id: Number(ins[0].insertId) };
  });

  // ---- Help requests from the portal ---------------------------------------------

  /** Everything waiting, or one client's requests. Newest activity first. */
  app.get('/api/v1/support', async (req, reply) => {
    const { accountId } = authOf(req);
    const q = z.object({
      folderId: z.coerce.number().int().positive().optional(),
      status: z.enum(['open', 'answered', 'closed', 'all']).optional(),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Bad filter.' });
    if (q.data.folderId && !(await clientFor(req, reply, q.data.folderId))) return;
    const status = q.data.status ?? 'all';
    const rows = await db.select({
      id: supportRequests.id, subject: supportRequests.subject, status: supportRequests.status,
      folderId: supportRequests.folderId, clientName: folders.name, businessId: supportRequests.businessId,
      businessName: businesses.name, lastMessageAt: supportRequests.lastMessageAt, createdAt: supportRequests.createdAt,
      taskId: supportRequests.taskId,
    }).from(supportRequests)
      .innerJoin(folders, eq(folders.id, supportRequests.folderId))
      .innerJoin(businesses, eq(businesses.id, supportRequests.businessId))
      .where(tenantWhere(supportRequests, accountId,
        q.data.folderId ? eq(supportRequests.folderId, q.data.folderId) : undefined,
        status === 'all' ? undefined : eq(supportRequests.status, status),
        await businessScope(req, supportRequests.businessId)))
      .orderBy(desc(supportRequests.lastMessageAt)).limit(200);
    return { requests: rows };
  });

  const requestFor = async (req: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) { await reply.code(400).send({ error: 'Bad id.' }); return null; }
    const [r] = await db.select().from(supportRequests)
      .where(tenantWhere(supportRequests, accountId, eq(supportRequests.id, id))).limit(1);
    if (!r || !(await canSeeBusiness(req, r.businessId))) {
      await reply.code(404).send({ error: 'That request is not here.' });
      return null;
    }
    return r;
  };

  app.get('/api/v1/support/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const r = await requestFor(req, reply);
    if (!r) return;
    const [client] = await db.select({ name: folders.name }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, r.folderId))).limit(1);
    const [asker] = r.portalUserId ? await db.select({ name: portalUsers.name, email: portalUsers.email }).from(portalUsers)
      .where(and(eq(portalUsers.accountId, accountId), eq(portalUsers.id, r.portalUserId))).limit(1) : [];
    const messages = await db.select({
      id: supportMessages.id, fromClient: supportMessages.fromClient, authorName: supportMessages.authorName,
      body: supportMessages.body, createdAt: supportMessages.createdAt,
    }).from(supportMessages)
      .where(tenantWhere(supportMessages, accountId, eq(supportMessages.requestId, r.id)))
      .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));
    return {
      request: {
        id: r.id, subject: r.subject, status: r.status, folderId: r.folderId, businessId: r.businessId,
        clientName: client?.name ?? '', askedBy: asker ? { name: asker.name, email: asker.email } : null,
        taskId: r.taskId, createdAt: r.createdAt,
      },
      messages,
    };
  });

  app.post('/api/v1/support/:id/reply', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({ body: z.string().trim().min(1).max(20000), close: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Write a reply first.' });
    const r = await requestFor(req, reply);
    if (!r) return;
    const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    await db.insert(supportMessages).values(withTenant(accountId, {
      requestId: r.id, fromClient: false, authorName: me?.name ?? null, userId, body: parsed.data.body,
    }));
    const status = parsed.data.close ? 'closed' as const : 'answered' as const;
    await db.update(supportRequests).set({ status, lastMessageAt: new Date() })
      .where(tenantWhere(supportRequests, accountId, eq(supportRequests.id, r.id)));

    // Tell the client, with the answer in the email itself so they need not sign in
    // to read it. Who asked, or failing that the client's billing address.
    const [asker] = r.portalUserId ? await db.select({ email: portalUsers.email, name: portalUsers.name }).from(portalUsers)
      .where(and(eq(portalUsers.accountId, accountId), eq(portalUsers.id, r.portalUserId))).limit(1) : [];
    const [client] = await db.select({ billingEmail: folders.billingEmail }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, r.folderId))).limit(1);
    const to = asker?.email ?? client?.billingEmail ?? null;
    let emailed = false;
    if (to) {
      const brand = await emailBrandFor(accountId, r.businessId);
      const content = {
        heading: `Re: ${r.subject}`,
        body: [...(asker?.name ? [`Hi ${asker.name.split(' ')[0]},`] : []), ...paragraphs(parsed.data.body)],
        button: { label: 'Open the conversation', url: `${appUrl()}/portal?help=${r.id}` },
        note: parsed.data.close
          ? 'We have marked this as done. If it is not, answer in your portal and it opens again.'
          : 'To answer, use the button above so the whole conversation stays in one place.',
      };
      try {
        await sendBusinessMail({
          accountId, businessId: r.businessId, purpose: 'general', to, subject: `Re: ${r.subject}`,
          text: renderEmailText(brand, content), html: renderEmail(brand, content),
        });
        emailed = true;
      } catch (err) { req.log.warn({ err }, 'support reply email failed'); }
    }
    return { ok: true, status, emailed };
  });

  app.post('/api/v1/support/:id/status', async (req, reply) => {
    const { accountId } = authOf(req);
    const parsed = z.object({ status: z.enum(['open', 'answered', 'closed']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Bad status.' });
    const r = await requestFor(req, reply);
    if (!r) return;
    await db.update(supportRequests).set({ status: parsed.data.status })
      .where(tenantWhere(supportRequests, accountId, eq(supportRequests.id, r.id)));
    return { ok: true };
  });

  /** How many are waiting on us, for the badge. */
  app.get('/api/v1/support-count', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select({ id: supportRequests.id }).from(supportRequests)
      .where(tenantWhere(supportRequests, accountId, inArray(supportRequests.status, ['open']),
        await businessScope(req, supportRequests.businessId)));
    return { open: rows.length };
  });
}
