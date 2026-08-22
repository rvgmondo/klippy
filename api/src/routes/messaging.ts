import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { messagingSettings, documents, businesses, accounts } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { assertBusinessAccess, assertMaybeBusiness } from '../lib/access.js';
import { encryptSecret, secretsAvailable } from '../lib/secretbox.js';
import { formatMoney } from '../lib/currency.js';
import { payLinkFor } from '../lib/paylink.js';
import { quoteLinkFor } from './quotes.js';
import {
  messagingFor, channelsFor, normalizePhone, phoneForClient, whatsappLink,
  reminderText, templateParams, sendSms, sendWhatsAppTemplate, type MessagingRow,
} from '../lib/messaging.js';

/**
 * Messaging settings (SMS / WhatsApp) and the click-to-chat links.
 *
 * Settings follow the PayFast shape exactly: an account-level default, an
 * optional per-business override, secrets write-only, admins only. The
 * click-to-chat link needs no settings at all: it is the founder's own phone
 * doing the sending.
 */

const patchSchema = z.object({
  smsProvider: z.enum(['none', 'bulksms']).optional(),
  smsTokenId: z.string().trim().max(120).nullable().optional(),
  smsTokenSecret: z.string().trim().max(200).nullable().optional(),
  smsSender: z.string().trim().max(20).nullable().optional(),
  waPhoneNumberId: z.string().trim().max(40).nullable().optional(),
  waAccessToken: z.string().trim().max(1000).nullable().optional(),
  waTemplateName: z.string().trim().max(100).nullable().optional(),
  waTemplateLang: z.string().trim().max(10).optional(),
  remindBySms: z.boolean().optional(),
  remindByWhatsapp: z.boolean().optional(),
});

function publicView(row: MessagingRow | null, scope: 'own' | 'workspace' | 'none') {
  const ch = channelsFor(row);
  return {
    scope,
    smsProvider: row?.smsProvider ?? 'none',
    smsTokenId: row?.smsTokenId ?? '',
    smsSecretSet: !!row?.smsTokenSecretEnc,
    smsSender: row?.smsSender ?? '',
    waPhoneNumberId: row?.waPhoneNumberId ?? '',
    waTokenSet: !!row?.waAccessTokenEnc,
    waTemplateName: row?.waTemplateName ?? '',
    waTemplateLang: row?.waTemplateLang ?? 'en',
    remindBySms: row?.remindBySms ?? false,
    remindByWhatsapp: row?.remindByWhatsapp ?? false,
    /** What will actually fire: switched on AND credentialed. */
    active: ch,
    secretsAvailable: secretsAvailable(),
  };
}

export async function messagingRoutes(app: FastifyInstance) {
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply) => {
    if (authOf(req).role === 'member') {
      void reply.code(403).send({ error: 'Only workspace admins can change messaging settings.' });
      return false;
    }
    return true;
  };

  const read = async (accountId: number, businessId: number) => {
    const [own] = await db.select().from(messagingSettings)
      .where(and(eq(messagingSettings.accountId, accountId), eq(messagingSettings.businessId, businessId))).limit(1);
    if (own) return publicView(own, 'own');
    if (businessId !== 0) {
      const fallback = await messagingFor(accountId, null);
      return publicView(fallback, fallback ? 'workspace' : 'none');
    }
    return publicView(null, 'none');
  };

  const write = async (accountId: number, businessId: number, body: unknown, reply: FastifyReply) => {
    const parsed = patchSchema.safeParse(body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;
    if ((d.smsTokenSecret || d.waAccessToken) && !secretsAvailable()) {
      return reply.code(400).send({ error: 'The server has no PAYMENTS_SECRET configured, so secrets cannot be stored.' });
    }
    const patch: Record<string, unknown> = {};
    if (d.smsProvider !== undefined) patch.smsProvider = d.smsProvider;
    if (d.smsTokenId !== undefined) patch.smsTokenId = d.smsTokenId || null;
    if (d.smsTokenSecret !== undefined) patch.smsTokenSecretEnc = d.smsTokenSecret ? encryptSecret(d.smsTokenSecret) : null;
    if (d.smsSender !== undefined) patch.smsSender = d.smsSender || null;
    if (d.waPhoneNumberId !== undefined) patch.waPhoneNumberId = d.waPhoneNumberId || null;
    if (d.waAccessToken !== undefined) patch.waAccessTokenEnc = d.waAccessToken ? encryptSecret(d.waAccessToken) : null;
    if (d.waTemplateName !== undefined) patch.waTemplateName = d.waTemplateName || null;
    if (d.waTemplateLang !== undefined) patch.waTemplateLang = d.waTemplateLang || 'en';
    if (d.remindBySms !== undefined) patch.remindBySms = d.remindBySms;
    if (d.remindByWhatsapp !== undefined) patch.remindByWhatsapp = d.remindByWhatsapp;

    const [existing] = await db.select({ id: messagingSettings.id }).from(messagingSettings)
      .where(and(eq(messagingSettings.accountId, accountId), eq(messagingSettings.businessId, businessId))).limit(1);
    if (existing) {
      if (Object.keys(patch).length) {
        await db.update(messagingSettings).set(patch).where(eq(messagingSettings.id, existing.id));
      }
    } else {
      await db.insert(messagingSettings).values({ accountId, businessId, ...patch });
    }
    return read(accountId, businessId);
  };

  // ---- Workspace default -----------------------------------------------------
  app.get('/api/v1/account/messaging', { preHandler: app.requireAuth }, async (req) => {
    const { accountId } = authOf(req);
    return read(accountId, 0);
  });
  app.patch('/api/v1/account/messaging', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { accountId } = authOf(req);
    return write(accountId, 0, req.body, reply);
  });

  // ---- Per business ------------------------------------------------------------
  app.get('/api/v1/businesses/:id/messaging', { preHandler: app.requireAuth }, async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    return read(accountId, id);
  });
  app.patch('/api/v1/businesses/:id/messaging', { preHandler: app.requireAuth }, async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    return write(accountId, id, req.body, reply);
  });
  app.delete('/api/v1/businesses/:id/messaging', { preHandler: app.requireAuth }, async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    await db.delete(messagingSettings)
      .where(and(eq(messagingSettings.accountId, accountId), eq(messagingSettings.businessId, id)));
    return read(accountId, id);
  });

  // ---- Send me a test ----------------------------------------------------------
  app.post('/api/v1/account/messaging/test', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { accountId } = authOf(req);
    const parsed = z.object({
      businessId: z.number().int().nonnegative().optional(),
      to: z.string().trim().min(6).max(40),
      channel: z.enum(['sms', 'whatsapp']),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a phone number and pick a channel.' });
    const to = normalizePhone(parsed.data.to);
    if (!to) return reply.code(400).send({ error: 'That does not look like a phone number.' });
    const row = await messagingFor(accountId, parsed.data.businessId || null);
    if (!row) return reply.code(400).send({ error: 'Save your messaging settings first.' });
    const [account] = await db.select({ name: accounts.name, brandName: accounts.brandName })
      .from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const brand = account?.brandName || account?.name || 'Klippy';
    const facts = {
      clientName: 'there', number: 'TEST-0001', amount: 'ZAR 1.00',
      whenPhrase: 'is a test message from Klippy', link: null, brand,
    };
    try {
      if (parsed.data.channel === 'sms') await sendSms(row, to, reminderText(facts));
      else await sendWhatsAppTemplate(row, to, templateParams(facts));
      return { ok: true, to: `+${to}` };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'The provider refused the message.' });
    }
  });

  // ---- Click-to-chat: the zero-setup layer ----------------------------------
  /**
   * A wa.me link with the reminder (or quote) pre-written, for the founder to
   * send from their own phone. Needs only a phone number on the client.
   */
  app.get('/api/v1/documents/:id/whatsapp-link', { preHandler: app.requireAuth }, async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [doc] = await db.select().from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, id))).limit(1);
    if (!doc) return reply.code(404).send({ error: 'Not found.' });
    if (!(await assertMaybeBusiness(req, reply, doc.businessId))) return;

    const phone = await phoneForClient(accountId, doc.folderId);
    if (!phone) {
      return reply.code(400).send({ error: 'This client has no phone number. Add one on the client (sidebar menu) or a contact first.' });
    }
    const [business] = doc.businessId
      ? await db.select({ brandName: businesses.brandName, name: businesses.name }).from(businesses)
        .where(tenantWhere(businesses, accountId, eq(businesses.id, doc.businessId))).limit(1)
      : [undefined];
    const [account] = await db.select({ name: accounts.name, brandName: accounts.brandName })
      .from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const brand = business?.brandName || business?.name || account?.brandName || account?.name || '';

    let text: string;
    if (doc.type === 'quote') {
      const link = quoteLinkFor(doc.id);
      text = `Hi ${doc.clientName}, here is quote ${doc.number} for ${formatMoney(doc.total, doc.currency)}`
        + (doc.dueDate ? ` (valid until ${doc.dueDate})` : '') + '.'
        + (link ? ` View and accept it here: ${link}` : '')
        + ` ${brand}`.trimEnd();
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const due = doc.dueDate;
      let whenPhrase = 'is outstanding';
      if (due) {
        const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000);
        whenPhrase = days > 0 ? `was due on ${due} (${days} day${days === 1 ? '' : 's'} ago)`
          : days === 0 ? 'is due today' : `is due on ${due}`;
      }
      const link = doc.status !== 'paid' ? await payLinkFor(accountId, doc.id).catch(() => null) : null;
      text = reminderText({
        clientName: doc.clientName, number: doc.number,
        amount: formatMoney(doc.total, doc.currency), whenPhrase, link, brand,
      });
    }
    return { url: whatsappLink(phone, text), phone: `+${phone}`, text };
  });
}
