import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { safeEqual } from '../lib/portalAuth.js';
import { jobRuns } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { isPlatformAdmin } from '../lib/platform.js';
import { JOBS, runJob, runDueJobs, type JobName } from '../lib/jobs.js';
import { runSocialPublish } from '../lib/social/publish.js';

/**
 * The daily jobs are run by the app itself (see lib/jobs.ts), so none of this needs
 * an external cron any more. What is left here is:
 *  - the original secret-protected endpoints, still useful for triggering a run from
 *    a real cron if someone would rather drive it that way, and
 *  - a signed-in view of what ran and when, so Settings can show it and offer a
 *    "run now" button instead of asking anyone to write a curl command.
 */
export async function cronRoutes(app: FastifyInstance) {
  const bySecret = (req: { headers: Record<string, unknown> }): 'ok' | 'unset' | 'bad' => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return 'unset';
    // Constant-time, so the key cannot be recovered a character at a time by
    // timing the reply. Cheap insurance on an endpoint that runs billing.
    const given = (req.headers['x-cron-key'] as string | undefined) ?? '';
    return safeEqual(given, secret) ? 'ok' : 'bad';
  };

  for (const job of JOBS) {
    app.post(`/api/v1/cron/${job.name}`, async (req, reply) => {
      const auth = bySecret(req as never);
      if (auth === 'unset') return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
      if (auth === 'bad') return reply.code(401).send({ error: 'Bad cron key.' });
      const res = await runJob(job.name);
      return reply.code(res.ok ? 200 : 500).send({ ok: res.ok, message: res.message });
    });
  }

  /**
   * The social publisher, once a minute.
   *
   * Registered by hand rather than through the JOBS registry above, and that is the
   * point: those jobs record a run per DATE in job_runs and refuse to run twice on the
   * same day, which is exactly right for a digest and exactly wrong for something due
   * every minute. Safety here comes from the claim instead. runSocialPublish moves a
   * row to `publishing` with a conditional UPDATE, so two overlapping runs cannot both
   * take the same post, and nothing is deduped by date at all.
   */
  app.post('/api/v1/cron/social-publish', async (req, reply) => {
    const auth = bySecret(req as never);
    if (auth === 'unset') return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
    if (auth === 'bad') return reply.code(401).send({ error: 'Bad cron key.' });
    try {
      const res = await runSocialPublish();
      return reply.code(200).send(res);
    } catch (err) {
      req.log.error({ err }, 'social publish run failed');
      return reply.code(500).send({ ok: false, error: 'The publish run failed. See the server log.' });
    }
  });

  /**
   * Are the connections still alive? Once a day.
   *
   * Registered here rather than in the daily JOBS registry for the same reason as the
   * publisher: it is about social accounts, and keeping the two social endpoints
   * together is how the cron setup stays one section rather than two.
   */
  app.post('/api/v1/cron/social-token-check', async (req, reply) => {
    const auth = bySecret(req as never);
    if (auth === 'unset') return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
    if (auth === 'bad') return reply.code(401).send({ error: 'Bad cron key.' });
    try {
      const { runSocialTokenCheck } = await import('../lib/social/health.js');
      return reply.code(200).send({ ok: true, message: await runSocialTokenCheck() });
    } catch (err) {
      req.log.error({ err }, 'social token check failed');
      return reply.code(500).send({ ok: false, error: 'The token check failed. See the server log.' });
    }
  });

  // ---- Signed-in automation view, for Settings ------------------------------
  // The jobs are global (each run sweeps every account, job_runs has no accountId),
  // so this whole panel is a platform-operator concern, not a per-tenant setting.
  // Gated to the operator, or a customer could read the platform's job state and its
  // aggregate run messages.
  app.get('/api/v1/automation', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!(await isPlatformAdmin(req))) return reply.code(403).send({ error: 'Automation is managed by the platform operator.' });
    const state = await db.select().from(jobRuns);
    const byName = new Map(state.map((s) => [s.name, s]));
    return {
      // Whether email can actually leave the server. Every job sends mail, so
      // without this they run and quietly deliver nothing.
      mailConfigured: !!process.env.SMTP_HOST,
      jobs: JOBS.map((j) => {
        const s = byName.get(j.name);
        return {
          name: j.name, label: j.label, description: j.description, hour: j.hour,
          enabled: s?.enabled ?? true,
          lastRunOn: s?.lastRunOn ?? null,
          lastRunAt: s?.lastRunAt ?? null,
          lastStatus: s?.lastStatus ?? null,
          lastMessage: s?.lastMessage ?? null,
        };
      }),
    };
  });

  /**
   * "Anything owing a run, run it now." Called by the app itself on load, which
   * makes opening Klippy (including the installed app on a phone) enough to keep
   * the daily jobs moving without any cron at all.
   *
   * Cheap to call repeatedly: it reads a handful of rows and does nothing once
   * today's runs are recorded.
   */
  app.post('/api/v1/automation/tick', { preHandler: app.requireAuth }, async () => {
    await runDueJobs();
    return { ok: true };
  });

  app.post('/api/v1/automation/:name/run', { preHandler: app.requireAuth }, async (req, reply) => {
    // Forces a global job to run now, off-schedule (e.g. hosting suspensions across
    // every account). Operator only.
    if (!(await isPlatformAdmin(req))) return reply.code(403).send({ error: 'Automation is managed by the platform operator.' });
    const name = (req.params as { name: string }).name as JobName;
    if (!JOBS.some((j) => j.name === name)) return reply.code(404).send({ error: 'No such job.' });
    const res = await runJob(name);
    return { ok: res.ok, message: res.message };
  });

  app.patch('/api/v1/automation/:name', { preHandler: app.requireAuth }, async (req, reply) => {
    const { userId } = authOf(req);
    if (!userId) return reply.code(401).send({ error: 'Not authenticated.' });
    // Enabling or disabling a job flips it for EVERY account, so this is the operator's
    // switch, not a customer's. Without this a customer could switch off the billing
    // that invoices every other customer.
    if (!(await isPlatformAdmin(req))) return reply.code(403).send({ error: 'Automation is managed by the platform operator.' });
    const name = (req.params as { name: string }).name as JobName;
    if (!JOBS.some((j) => j.name === name)) return reply.code(404).send({ error: 'No such job.' });
    const enabled = (req.body as { enabled?: boolean } | null)?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false.' });

    const [existing] = await db.select().from(jobRuns).where(eq(jobRuns.name, name)).limit(1);
    if (existing) await db.update(jobRuns).set({ enabled }).where(eq(jobRuns.name, name));
    else await db.insert(jobRuns).values({ name, enabled });
    return { ok: true, enabled };
  });
}
