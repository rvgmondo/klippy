import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobRuns } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { JOBS, runJob } from '../lib/jobs.js';
/**
 * The daily jobs are run by the app itself (see lib/jobs.ts), so none of this needs
 * an external cron any more. What is left here is:
 *  - the original secret-protected endpoints, still useful for triggering a run from
 *    a real cron if someone would rather drive it that way, and
 *  - a signed-in view of what ran and when, so Settings can show it and offer a
 *    "run now" button instead of asking anyone to write a curl command.
 */
export async function cronRoutes(app) {
    const bySecret = (req) => {
        const secret = process.env.CRON_SECRET;
        if (!secret)
            return 'unset';
        return req.headers['x-cron-key'] === secret ? 'ok' : 'bad';
    };
    for (const job of JOBS) {
        app.post(`/api/v1/cron/${job.name}`, async (req, reply) => {
            const auth = bySecret(req);
            if (auth === 'unset')
                return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
            if (auth === 'bad')
                return reply.code(401).send({ error: 'Bad cron key.' });
            const res = await runJob(job.name);
            return reply.code(res.ok ? 200 : 500).send({ ok: res.ok, message: res.message });
        });
    }
    // ---- Signed-in automation view, for Settings ------------------------------
    app.get('/api/v1/automation', { preHandler: app.requireAuth }, async () => {
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
    app.post('/api/v1/automation/:name/run', { preHandler: app.requireAuth }, async (req, reply) => {
        const name = req.params.name;
        if (!JOBS.some((j) => j.name === name))
            return reply.code(404).send({ error: 'No such job.' });
        const res = await runJob(name);
        return { ok: res.ok, message: res.message };
    });
    app.patch('/api/v1/automation/:name', { preHandler: app.requireAuth }, async (req, reply) => {
        const { userId } = authOf(req);
        if (!userId)
            return reply.code(401).send({ error: 'Not authenticated.' });
        const name = req.params.name;
        if (!JOBS.some((j) => j.name === name))
            return reply.code(404).send({ error: 'No such job.' });
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean')
            return reply.code(400).send({ error: 'enabled must be true or false.' });
        const [existing] = await db.select().from(jobRuns).where(eq(jobRuns.name, name)).limit(1);
        if (existing)
            await db.update(jobRuns).set({ enabled }).where(eq(jobRuns.name, name));
        else
            await db.insert(jobRuns).values({ name, enabled });
        return { ok: true, enabled };
    });
}
//# sourceMappingURL=cron.js.map