import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, deals } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { assertBusinessAccess } from '../lib/access.js';
import { signLeadToken, verifyLeadToken } from '../lib/secretbox.js';
import { appUrl } from '../lib/mailer.js';
import { rateLimit } from '../lib/rateLimit.js';
import { notifyAdmins } from '../lib/notify.js';

/**
 * Inbound lead capture: the pipeline stops needing the founder as its typist.
 *
 * Every lead used to arrive somewhere else (a website form, a WhatsApp, a
 * referral) and wait for a human to re-type it into the pipeline. This is a
 * spam-guarded PUBLIC endpoint that creates the deal directly, plus a tiny hosted
 * form for founders whose website has no form to wire up: link to it from
 * anywhere, and submissions land in the pipeline as leads marked with their
 * source.
 *
 * The URL carries a signed token (HMAC over the business id, same recipe as the
 * pay link) so it cannot be forged or enumerated; the form carries a honeypot
 * field bots fill and humans never see; and the endpoint is rate limited per IP.
 */
const leadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(150).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(150).optional(),
  message: z.string().trim().max(2000).optional(),
  // The honeypot: a field named like something a bot wants to fill, hidden from
  // people. Anything in it means machine; we answer success and write nothing.
  website: z.string().optional(),
});

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function leadRoutes(app: FastifyInstance) {
  // The hosted form posts urlencoded, which Fastify does not parse by default.
  // Parsers are plugin-scoped, so this stays local to the lead routes.
  app.addContentTypeParser('application/x-www-form-urlencoded',
    { parseAs: 'string' }, (_req, body, done) => {
      const parsed: Record<string, string> = {};
      for (const pair of String(body).split('&')) {
        if (!pair) continue;
        const i = pair.indexOf('=');
        const k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
        const v = i === -1 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        parsed[k] = v;
      }
      done(null, parsed);
    });

  // ---- Where do I point my website? (authed) --------------------------------
  app.get('/api/v1/businesses/:id/lead-link', { preHandler: app.requireAuth }, async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'member'))) return;
    const token = signLeadToken(id);
    if (!token) {
      return reply.code(400).send({ error: 'The server has no PAYMENTS_SECRET configured, so signed public links are off.' });
    }
    const url = `${appUrl()}/api/v1/public/lead/${id}?t=${token}`;
    return {
      url,
      // Ready to paste into any site: posts straight to the endpoint above.
      embed: `<form action="${url}" method="post">\n`
        + `  <input name="name" placeholder="Your name" required>\n`
        + `  <input name="email" type="email" placeholder="Email">\n`
        + `  <input name="message" placeholder="What do you need?">\n`
        + `  <input name="website" style="display:none" tabindex="-1" autocomplete="off">\n`
        + `  <button type="submit">Send</button>\n`
        + `</form>`,
    };
  });

  // ---- The hosted form (PUBLIC) --------------------------------------------
  app.get('/api/v1/public/lead/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const t = (req.query as { t?: string }).t ?? '';
    if (!id || !verifyLeadToken(id, t)) return reply.code(404).send({ error: 'Not found.' });
    const [biz] = await db.select({ name: businesses.name, brandName: businesses.brandName })
      .from(businesses).where(eq(businesses.id, id)).limit(1);
    if (!biz) return reply.code(404).send({ error: 'Not found.' });
    const brand = esc(biz.brandName || biz.name);
    const sent = (req.query as { sent?: string }).sent === '1';
    return reply.type('text/html').send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>Contact ${brand}</title>`
      + `<body style="margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a">`
      + `<div style="max-width:420px;margin:10vh auto;padding:0 24px">`
      + `<h1 style="font-size:22px;margin-bottom:4px">Contact ${brand}</h1>`
      + (sent
        ? `<p style="color:#16a34a;font-weight:600">Thank you. Your message has been received and ${brand} will be in touch.</p>`
        : `<p style="color:#64748b;font-size:14px;margin-bottom:20px">Tell us what you need and we will come back to you.</p>`
          + `<form method="post" action="/api/v1/public/lead/${id}?t=${esc(t)}&form=1" style="display:grid;gap:10px">`
          + `<input name="name" placeholder="Your name" required style="padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">`
          + `<input name="email" type="email" placeholder="Email" style="padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">`
          + `<input name="phone" placeholder="Phone (optional)" style="padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">`
          + `<textarea name="message" placeholder="What do you need?" rows="4" style="padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px"></textarea>`
          + `<input name="website" style="display:none" tabindex="-1" autocomplete="off">`
          + `<button type="submit" style="padding:11px;border:0;border-radius:8px;background:#0f172a;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Send</button>`
          + `</form>`)
      + `</div></body>`);
  });

  // ---- The submission (PUBLIC, rate limited) --------------------------------
  app.post('/api/v1/public/lead/:id', {
    preHandler: rateLimit({ windowMs: 5 * 60_000, max: 10, key: (req) => `lead:${req.ip}` }),
  }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const t = (req.query as { t?: string }).t ?? '';
    const fromForm = (req.query as { form?: string }).form === '1';
    if (!id || !verifyLeadToken(id, t)) return reply.code(404).send({ error: 'Not found.' });

    // The hosted form posts urlencoded; API callers post JSON. Accept both.
    const parsed = leadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const done = () => fromForm
      ? reply.redirect(`/api/v1/public/lead/${id}?t=${t}&sent=1`, 303)
      : reply.code(201).send({ ok: true });

    // A filled honeypot means a bot. Answer success, write nothing: an error would
    // just teach it which field to skip.
    if (d.website && d.website.trim()) return done();

    const [biz] = await db.select({ id: businesses.id, accountId: businesses.accountId })
      .from(businesses).where(eq(businesses.id, id)).limit(1);
    if (!biz) return reply.code(404).send({ error: 'Not found.' });

    const [posRow] = await db.select({ pos: sql<number>`COALESCE(MAX(position), 0) + 1` })
      .from(deals).where(tenantWhere(deals, biz.accountId, eq(deals.stage, 'lead')));
    const pos = posRow?.pos ?? 0;

    await db.insert(deals).values(withTenant(biz.accountId, {
      businessId: biz.id,
      title: d.company?.trim() || d.name,
      company: d.company?.trim() || null,
      contactName: d.name,
      contactEmail: d.email?.trim() || null,
      contactPhone: d.phone?.trim() || null,
      value: '0.00',
      stage: 'lead' as const,
      source: 'Website form',
      notes: d.message?.trim() || null,
      position: Number(pos),
      createdBy: null,
    }));

    // The whole point of capturing a lead is that someone hears about it NOW,
    // not when they next happen to open the pipeline.
    await notifyAdmins(biz.accountId, {
      kind: 'lead',
      title: `New lead: ${d.company?.trim() || d.name}`,
      body: [d.name, d.email?.trim(), d.message?.trim()].filter(Boolean).join(' | ').slice(0, 400),
      url: '/?v=pipeline',
    });
    return done();
  });
}
