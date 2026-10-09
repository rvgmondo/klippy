import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { safeEqual } from '../lib/portalAuth.js';
import { jobRuns } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { isPlatformAdmin } from '../lib/platform.js';
import { JOBS, runJob, runDueJobs } from '../lib/jobs.js';
import { runSocialPublish } from '../lib/social/publish.js';
import { syncStaleFeeds } from '../lib/calendarFeeds.js';
import { secretsAvailable } from '../lib/secretbox.js';
import { appUrl } from '../lib/mailer.js';
/** The job_runs row that records the server cron knocking, for the set-up check. */
const CRON_ROW = 'cron-tick';
/**
 * Is everything the background work needs actually in place?
 *
 * Reminders, recurring invoices, follow-ups, statements and calendar sync all run
 * on their own, and every one of them does NOTHING, silently, when the server is
 * missing a setting or nothing wakes the app. This says so in plain words, with
 * the fix, instead of leaving it to be noticed when a client was never chased.
 * Only presence is reported, never a value.
 */
export function setupChecks(byName) {
    const out = [];
    const prod = process.env.NODE_ENV === 'production';
    out.push(process.env.SMTP_HOST
        ? { key: 'mail', label: 'Email', state: 'ok', detail: 'A mail server is set, so emails can leave.' }
        : { key: 'mail', label: 'Email', state: 'bad', detail: 'No mail server is set, so reminders, invoices and reports go nowhere. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in cPanel and restart the app.' });
    const url = appUrl();
    out.push(/localhost|127\.0\.0\.1/.test(url) && prod
        ? { key: 'url', label: 'Links in emails', state: 'bad', detail: `APP_URL is ${url}, so every link in an email points nowhere. Set it to the address people use, then restart.` }
        : { key: 'url', label: 'Links in emails', state: 'ok', detail: `Links point to ${url}.` });
    out.push(secretsAvailable()
        ? { key: 'secret', label: 'Encryption key', state: 'ok', detail: 'PAYMENTS_SECRET is set, so card details and calendar links can be stored safely.' }
        : { key: 'secret', label: 'Encryption key', state: 'bad', detail: 'PAYMENTS_SECRET is not set, so card payments and reading your Outlook calendar cannot work. Add a long random value in cPanel and restart.' });
    out.push((process.env.SOCIAL_TOKEN_KEY ?? '').length >= 16
        ? { key: 'social', label: 'Social media key', state: 'ok', detail: 'SOCIAL_TOKEN_KEY is set, so Facebook, Instagram and LinkedIn can be connected.' }
        : { key: 'social', label: 'Social media key', state: 'warn', detail: 'SOCIAL_TOKEN_KEY is not set, so social accounts cannot be connected. Add a long random value in cPanel and restart. Only needed if you post from Klippy.' });
    out.push(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
        ? { key: 'push', label: 'Phone notifications', state: 'ok', detail: 'Push keys are set.' }
        : { key: 'push', label: 'Phone notifications', state: 'warn', detail: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set, so the installed app cannot buzz your phone. Optional.' });
    out.push(process.env.CRON_SECRET
        ? { key: 'cronkey', label: 'Cron key', state: 'ok', detail: 'CRON_SECRET is set.' }
        : { key: 'cronkey', label: 'Cron key', state: 'bad', detail: 'CRON_SECRET is not set, so the cPanel cron below is refused. Add a long random value in cPanel and restart.' });
    // The cron that wakes the app. cPanel puts an idle app to sleep, and a sleeping
    // app runs nothing until somebody opens it.
    const tick = byName.get(CRON_ROW)?.lastRunAt;
    const ageMin = tick ? (Date.now() - new Date(tick).getTime()) / 60000 : null;
    out.push(ageMin == null
        ? { key: 'cron', label: 'Wake-up cron', state: 'bad', detail: 'The cPanel cron has never reached Klippy, so the daily work only happens when someone opens the app. Add the cron line below, every 15 minutes.' }
        : ageMin <= 60
            ? { key: 'cron', label: 'Wake-up cron', state: 'ok', detail: `Last knocked ${Math.max(1, Math.round(ageMin))} min ago.` }
            : { key: 'cron', label: 'Wake-up cron', state: 'warn', detail: `Last knocked ${ageMin < 1440 ? `${Math.round(ageMin / 60)} hours` : `${Math.round(ageMin / 1440)} days`} ago. Check the cron is still in cPanel.` });
    const failed = JOBS.filter((j) => byName.get(j.name)?.lastStatus === 'failed');
    out.push(failed.length
        ? { key: 'failed', label: 'Daily jobs', state: 'bad', detail: `Failed on their last run: ${failed.map((j) => j.label).join(', ')}. The reason is beside each one below.` }
        : { key: 'failed', label: 'Daily jobs', state: 'ok', detail: 'None failed on their last run.' });
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    const missed = JOBS.filter((j) => {
        const s = byName.get(j.name);
        return (s?.enabled ?? true) && hour >= j.hour + 1 && s?.lastRunOn !== today;
    });
    if (missed.length)
        out.push({ key: 'missed', label: 'Today\'s run', state: 'warn', detail: `Not run yet today, though their time has passed: ${missed.map((j) => j.label).join(', ')}. Usually the app was asleep; the wake-up cron fixes that.` });
    return out;
}
export async function cronRoutes(app) {
    const bySecret = (req) => {
        const secret = process.env.CRON_SECRET;
        if (!secret)
            return 'unset';
        // Constant-time, so the key cannot be recovered a character at a time by
        // timing the reply. Cheap insurance on an endpoint that runs billing.
        const given = req.headers['x-cron-key'] ?? '';
        return safeEqual(given, secret) ? 'ok' : 'bad';
    };
    /**
     * The one cron to set up: run whatever is due, exactly as the app does when awake.
     *
     * On cPanel the app is put to sleep when nobody is using it, and a sleeping app
     * runs nothing: no reminders, no monthly invoices, until someone opens Klippy.
     * A server cron calling this every 15 minutes keeps it moving. Safe to call as
     * often as you like: each job runs at most once a day, after its hour, through
     * the same atomic claim. (The per-job endpoints below run a job EVERY time they
     * are called, so they are for a one-off run, not for a schedule.)
     */
    app.post('/api/v1/cron/tick', async (req, reply) => {
        const auth = bySecret(req);
        if (auth === 'unset')
            return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
        if (auth === 'bad')
            return reply.code(401).send({ error: 'Bad cron key.' });
        // Noted first, so the set-up check can say the cron is working even on a tick
        // where nothing else was due.
        await db.insert(jobRuns).values({ name: CRON_ROW, lastRunOn: new Date().toISOString().slice(0, 10), lastRunAt: new Date(), lastStatus: 'ok' })
            .onDuplicateKeyUpdate({ set: { lastRunOn: new Date().toISOString().slice(0, 10), lastRunAt: new Date(), lastStatus: 'ok' } })
            .catch(() => { });
        await runDueJobs();
        // Outside calendars too, so they stay fresh while the app sleeps.
        await syncStaleFeeds().catch(() => 0);
        return { ok: true };
    });
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
        const auth = bySecret(req);
        if (auth === 'unset')
            return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
        if (auth === 'bad')
            return reply.code(401).send({ error: 'Bad cron key.' });
        try {
            const res = await runSocialPublish();
            return reply.code(200).send(res);
        }
        catch (err) {
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
        const auth = bySecret(req);
        if (auth === 'unset')
            return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
        if (auth === 'bad')
            return reply.code(401).send({ error: 'Bad cron key.' });
        try {
            const { runSocialTokenCheck } = await import('../lib/social/health.js');
            return reply.code(200).send({ ok: true, message: await runSocialTokenCheck() });
        }
        catch (err) {
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
        if (!(await isPlatformAdmin(req)))
            return reply.code(403).send({ error: 'Automation is managed by the platform operator.' });
        const state = await db.select().from(jobRuns);
        const byName = new Map(state.map((s) => [s.name, s]));
        return {
            // Whether email can actually leave the server. Every job sends mail, so
            // without this they run and quietly deliver nothing.
            mailConfigured: !!process.env.SMTP_HOST,
            checks: setupChecks(byName),
            // What to paste into cPanel. The key is never sent back; the owner has it.
            cronCommand: `curl -s -X POST -H "X-Cron-Key: YOUR_CRON_SECRET" ${appUrl()}/api/v1/cron/tick`,
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
        if (!(await isPlatformAdmin(req)))
            return reply.code(403).send({ error: 'Automation is managed by the platform operator.' });
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
        // Enabling or disabling a job flips it for EVERY account, so this is the operator's
        // switch, not a customer's. Without this a customer could switch off the billing
        // that invoices every other customer.
        if (!(await isPlatformAdmin(req)))
            return reply.code(403).send({ error: 'Automation is managed by the platform operator.' });
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