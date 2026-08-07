import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { hostingAccounts, hostingSettings, subscriptions, folders, offerings, events } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { encryptSecret, secretsAvailable } from '../lib/secretbox.js';
import { assertBusinessAccess } from '../lib/access.js';
import { hostingSettingsFor, credsOf, provisionSubscription, setSuspended } from '../lib/hosting.js';
import { cleanHost, listPackages, testConnection, type WhmCreds } from '../lib/whm.js';

/**
 * Hosting provisioning: connecting Klippy to the WHM server that actually creates
 * cPanel accounts.
 *
 * Scoped exactly like payment settings, since a business that banks its own money
 * may well run its own server too. Read the rails in lib/hosting.ts before changing
 * anything: this reaches out and changes a live server.
 */
export async function hostingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  const read = async (accountId: number, businessId: number) => {
    const [row] = await db.select().from(hostingSettings)
      .where(and(eq(hostingSettings.accountId, accountId), eq(hostingSettings.businessId, businessId)))
      .limit(1);
    const effective = businessId ? await hostingSettingsFor(accountId, businessId) : row;
    return {
      configured: {
        whmHost: row?.whmHost ?? '',
        whmUser: row?.whmUser ?? 'root',
        hasToken: !!row?.whmTokenEnc,
        allowSelfSigned: row?.allowSelfSigned ?? false,
        enabled: row?.enabled ?? false,
        live: row?.live ?? false,
      },
      source: businessId ? (row ? 'own' : (effective ? 'workspace' : 'none')) : (row ? 'own' : 'none'),
      effectiveHost: effective?.enabled ? (effective.whmHost ?? '') : '',
      serverReady: secretsAvailable(),
    };
  };

  const write = async (
    accountId: number, businessId: number, body: unknown,
    reply: { code: (n: number) => { send: (o: unknown) => unknown } },
  ) => {
    const parsed = z.object({
      whmHost: z.string().trim().max(190).optional(),
      whmUser: z.string().trim().max(60).optional(),
      whmToken: z.string().trim().max(400).optional(),
      allowSelfSigned: z.boolean().optional(),
      enabled: z.boolean().optional(),
      live: z.boolean().optional(),
    }).safeParse(body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    if (d.whmToken && !secretsAvailable()) {
      return reply.code(503).send({ error: 'The server cannot store secrets yet. Set PAYMENTS_SECRET in the app environment and restart.' });
    }

    const scope = and(eq(hostingSettings.accountId, accountId), eq(hostingSettings.businessId, businessId));
    const [existing] = await db.select().from(hostingSettings).where(scope).limit(1);

    if (d.enabled && !(d.whmHost ?? existing?.whmHost) ) {
      return reply.code(400).send({ error: 'Add the WHM hostname before enabling hosting.' });
    }
    if (d.enabled && !(d.whmToken || existing?.whmTokenEnc)) {
      return reply.code(400).send({ error: 'Add a WHM API token before enabling hosting.' });
    }
    // Creating real accounts on a real server needs hosting switched on first, and
    // switching hosting off takes live with it rather than leaving it armed.
    if (d.live) {
      const on = d.enabled ?? existing?.enabled;
      if (!on) return reply.code(400).send({ error: 'Switch hosting on before enabling live provisioning.' });
    }

    const patch: Record<string, unknown> = {};
    if (d.whmHost !== undefined) patch.whmHost = cleanHost(d.whmHost) || null;
    if (d.whmUser !== undefined) patch.whmUser = d.whmUser || 'root';
    if (d.whmToken) patch.whmTokenEnc = encryptSecret(d.whmToken);
    if (d.allowSelfSigned !== undefined) patch.allowSelfSigned = d.allowSelfSigned;
    if (d.enabled !== undefined) {
      patch.enabled = d.enabled;
      if (!d.enabled) patch.live = false;
    }
    if (d.live !== undefined) patch.live = d.live;

    if (existing) await db.update(hostingSettings).set(patch).where(scope);
    else await db.insert(hostingSettings).values(withTenant(accountId, { ...patch, businessId } as never));
    return { ok: true };
  };

  app.get('/api/v1/account/hosting', async (req) => read(authOf(req).accountId, 0));

  app.patch('/api/v1/account/hosting', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only workspace admins can change settings.' });
    return write(accountId, 0, req.body, reply);
  });

  app.get('/api/v1/businesses/:id/hosting', async (req, reply) => {
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    return read(authOf(req).accountId, id);
  });

  app.patch('/api/v1/businesses/:id/hosting', async (req, reply) => {
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    return write(authOf(req).accountId, id, req.body, reply);
  });

  app.delete('/api/v1/businesses/:id/hosting', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBusinessAccess(req, reply, id, 'admin'))) return;
    await db.delete(hostingSettings)
      .where(and(eq(hostingSettings.accountId, accountId), eq(hostingSettings.businessId, id)));
    return { ok: true };
  });

  /**
   * Try the connection with credentials that may not be saved yet.
   *
   * Takes an optional token from the request so the settings can be proven before
   * being stored, which is the difference between "it says enabled" and "it works".
   */
  app.post('/api/v1/hosting/test', async (req, reply) => {
    const { accountId } = authOf(req);
    const parsed = z.object({
      businessId: z.number().int().nonnegative().optional(),
      whmHost: z.string().trim().max(190).optional(),
      whmUser: z.string().trim().max(60).optional(),
      whmToken: z.string().trim().max(400).optional(),
      allowSelfSigned: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const d = parsed.data;

    const businessId = d.businessId ?? 0;
    if (businessId && !(await assertBusinessAccess(req, reply, businessId, 'admin'))) return;
    const [stored] = await db.select().from(hostingSettings)
      .where(and(eq(hostingSettings.accountId, accountId), eq(hostingSettings.businessId, businessId)))
      .limit(1);

    const host = cleanHost(d.whmHost || stored?.whmHost || '');
    if (!host) return reply.code(400).send({ error: 'Add the WHM hostname first.' });
    let token = d.whmToken || '';
    if (!token && stored?.whmTokenEnc) {
      const fromStore = credsOf(stored);
      token = fromStore?.token ?? '';
    }
    if (!token) return reply.code(400).send({ error: 'Add a WHM API token first.' });

    const creds: WhmCreds = {
      host, user: d.whmUser || stored?.whmUser || 'root', token,
      allowSelfSigned: d.allowSelfSigned ?? stored?.allowSelfSigned ?? false,
    };
    const res = await testConnection(creds);
    if (!res.ok) return { ok: false, message: res.message, packages: [] };
    const pkgs = await listPackages(creds);
    return { ok: true, message: res.message, packages: pkgs.ok ? (pkgs.data ?? []).map((p) => p.name) : [] };
  });

  /** Hosting accounts Klippy knows about, newest first. */
  app.get('/api/v1/hosting/accounts', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select({
      id: hostingAccounts.id, businessId: hostingAccounts.businessId,
      subscriptionId: hostingAccounts.subscriptionId, domain: hostingAccounts.domain,
      username: hostingAccounts.username, whmPackage: hostingAccounts.whmPackage,
      status: hostingAccounts.status, detail: hostingAccounts.detail,
      createdAt: hostingAccounts.createdAt, clientName: folders.name,
    }).from(hostingAccounts)
      .leftJoin(subscriptions, eq(subscriptions.id, hostingAccounts.subscriptionId))
      .leftJoin(folders, eq(folders.id, subscriptions.folderId))
      .where(eq(hostingAccounts.accountId, accountId))
      .orderBy(desc(hostingAccounts.id))
      .limit(100);
    return { accounts: rows };
  });

  app.post('/api/v1/hosting/accounts/:id/suspend', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can suspend hosting.' });
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const body = z.object({ suspend: z.boolean(), reason: z.string().max(200).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    const res = await setSuspended(accountId, id, body.data.suspend, body.data.reason ?? 'Unpaid');
    if (!res.ok) return reply.code(400).send({ error: res.message });
    return { ok: true, message: res.message };
  });

  /** Provision a subscription by hand: the retry after a failure, or a first run. */
  app.post('/api/v1/subscriptions/:id/provision', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can provision hosting.' });
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [sub] = await db.select({ businessId: subscriptions.businessId }).from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, id))).limit(1);
    if (!sub) return reply.code(404).send({ error: 'Subscription not found.' });
    if (!(await assertBusinessAccess(req, reply, sub.businessId, 'admin'))) return;
    const res = await provisionSubscription(accountId, id);
    return { ok: res.outcome === 'created' || res.outcome === 'dry-run', ...res };
  });

  /** What provisioning has done, including what it refused. */
  app.get('/api/v1/hosting/activity', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select({
      id: events.id, createdAt: events.createdAt, payload: events.payload, results: events.results,
    }).from(events)
      .where(and(eq(events.accountId, accountId), eq(events.name, 'hosting.provision')))
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

  /** Offerings that provision hosting, for the settings screen to point at. */
  app.get('/api/v1/hosting/offerings', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select({
      id: offerings.id, name: offerings.name, businessId: offerings.businessId,
      whmPackage: offerings.whmPackage,
    }).from(offerings)
      .where(and(eq(offerings.accountId, accountId), eq(offerings.provisioning, 'cpanel')));
    return { offerings: rows };
  });
}
