import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { authPlugin } from './lib/context.js';
// Importing this registers the Golden Handoff handlers on the event hub.
import './lib/handoff.js';
import { authRoutes } from './routes/auth.js';
import { folderRoutes } from './routes/folders.js';
import { boardRoutes } from './routes/boards.js';
import { columnRoutes } from './routes/columns.js';
import { taskRoutes } from './routes/tasks.js';
import { subtaskRoutes } from './routes/subtasks.js';
import { commentRoutes } from './routes/comments.js';
import { timerRoutes } from './routes/timer.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { commandRoutes } from './routes/command.js';
import { calendarEventRoutes } from './routes/calendarEvents.js';
import { fileRoutes } from './routes/files.js';
import { accountRoutes } from './routes/account.js';
import { userRoutes } from './routes/users.js';
import { searchRoutes } from './routes/search.js';
import { tokenRoutes } from './routes/tokens.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { brandingRoutes } from './routes/branding.js';
import { storageRoutes } from './routes/storage.js';
import { noteRoutes } from './routes/notes.js';
import { reportRoutes } from './routes/reports.js';
import { pushRoutes } from './routes/push.js';
import { documentRoutes } from './routes/documents.js';
import { dealRoutes } from './routes/deals.js';
import { businessRoutes } from './routes/businesses.js';
import { offeringRoutes } from './routes/offerings.js';
import { expenseRoutes } from './routes/expenses.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { MAX_STORAGE_BYTES } from './lib/storage.js';
import { teamRoutes } from './routes/teams.js';
import { cronRoutes } from './routes/cron.js';
import { labelRoutes } from './routes/labels.js';
import { paymentRoutes } from './routes/payments.js';
import { hostingRoutes } from './routes/hosting.js';
import { portalRoutes, portalAdminRoutes } from './routes/portal.js';
import { crmRoutes } from './routes/crm.js';
const isProd = process.env.NODE_ENV === 'production';
export function buildServer() {
    const app = Fastify({
        logger: isProd
            ? true
            : { transport: undefined, level: 'info' },
        trustProxy: true, // behind Apache/Passenger on cPanel
        // On cPanel the app is mounted at <subdomain>/api. Depending on Passenger's
        // sub-URI handling, requests may arrive with or without the /api prefix;
        // rewriteUrl runs before routing, so both shapes hit the same routes.
        rewriteUrl(req) {
            const url = req.url ?? '/';
            return url.startsWith('/v1/') ? '/api' + url : url;
        },
    });
    app.register(cookie, {});
    app.register(multipart, { limits: { fileSize: MAX_STORAGE_BYTES, files: 1 } });
    const origins = (process.env.CORS_ORIGIN ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    app.register(cors, {
        origin: origins.length ? origins : true,
        credentials: true,
    });
    /**
     * Any unhandled error would otherwise surface as a bare "Internal Server Error",
     * which tells whoever hit it nothing and leaves no trail. Log the whole thing
     * (route, and the database's own message when it is a driver error) and hand back
     * something a person can actually report.
     */
    app.setErrorHandler((rawErr, req, reply) => {
        const err = rawErr;
        const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
        if (status >= 500) {
            req.log.error({
                err,
                url: req.url,
                method: req.method,
                // mysql2 puts the useful part here.
                dbCode: err.code,
                sqlMessage: err.sqlMessage,
            }, 'request failed');
        }
        // Drizzle wraps driver failures in a generic "Failed query", which hides the one
        // line that actually identifies the problem ("Unknown column ...", "Table doesn't
        // exist ..."). Put the driver's own message in the reply so a report of a broken
        // page carries the cause with it.
        reply.code(status).send({
            error: status >= 500
                ? `Something broke handling ${req.method} ${req.url}. ${err.message}`
                : err.message,
            ...(status >= 500 && err.sqlMessage ? { cause: err.sqlMessage, dbCode: err.code } : {}),
        });
    });
    app.get('/api/v1/health', async () => ({
        ok: true,
        service: 'klippy-api',
        time: new Date().toISOString(),
    }));
    app.register(authPlugin);
    app.register(authRoutes);
    app.register(folderRoutes);
    app.register(boardRoutes);
    app.register(columnRoutes);
    app.register(taskRoutes);
    app.register(subtaskRoutes);
    app.register(commentRoutes);
    app.register(timerRoutes);
    app.register(dashboardRoutes);
    app.register(commandRoutes);
    app.register(calendarEventRoutes);
    app.register(fileRoutes);
    app.register(accountRoutes);
    app.register(userRoutes);
    app.register(searchRoutes);
    app.register(tokenRoutes);
    app.register(workspaceRoutes);
    app.register(brandingRoutes);
    app.register(storageRoutes);
    app.register(noteRoutes);
    app.register(reportRoutes);
    app.register(pushRoutes);
    app.register(documentRoutes);
    app.register(dealRoutes);
    app.register(businessRoutes);
    app.register(offeringRoutes);
    app.register(expenseRoutes);
    app.register(subscriptionRoutes);
    app.register(teamRoutes);
    app.register(cronRoutes);
    app.register(labelRoutes);
    app.register(paymentRoutes);
    app.register(hostingRoutes);
    app.register(portalRoutes);
    app.register(portalAdminRoutes);
    app.register(crmRoutes);
    return app;
}
// Passenger sets PORT; default for local dev.
const port = Number(process.env.PORT ?? 8090);
const host = '0.0.0.0';
async function start() {
    // Auto-apply pending DB migrations, so a code deploy also updates the schema.
    const { runMigrations } = await import('./db/migrate.js');
    try {
        await runMigrations();
        // eslint-disable-next-line no-console
        console.log('klippy-api migrations up to date');
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error('klippy-api migration failed:', err);
        process.exit(1);
    }
    // Run the daily jobs in-process, so none of this needs an external cron.
    const { startScheduler } = await import('./lib/jobs.js');
    startScheduler();
    const addr = await buildServer().listen({ port, host });
    // eslint-disable-next-line no-console
    console.log(`klippy-api listening on ${addr}`);
}
start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map