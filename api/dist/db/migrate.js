import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db } from './client.js';
/**
 * Every table the app expects to exist once migrations have run. Adding a table to
 * the schema means adding it here too.
 */
const EXPECTED_TABLES = [
    'accounts', 'api_tokens', 'auto_debit_attempts', 'board_columns', 'board_teams',
    'boards', 'business_email', 'business_members', 'businesses', 'calendar_events',
    'contacts', 'deal_activities', 'deals', 'document_lines', 'documents', 'events',
    'expenses', 'focus_sessions', 'folders', 'hosting_accounts', 'hosting_settings',
    'job_runs', 'labels', 'memberships', 'offerings', 'payment_settings', 'payments',
    'portal_login_tokens', 'portal_users', 'product_notes', 'push_subscriptions',
    'storage_nodes', 'subscriptions', 'task_comments', 'task_files', 'task_labels',
    'task_subtasks', 'tasks', 'team_members', 'teams', 'time_entries', 'users',
];
/**
 * Confirm the schema actually looks the way the code expects.
 *
 * Migrations can be skipped without failing: Drizzle only compares each migration's
 * timestamp against the newest row in `__drizzle_migrations`, so a single row with a
 * timestamp ahead of pending migrations makes them count as done. That happened on
 * production and went unnoticed for days, because the app booted perfectly and only
 * broke later when a query hit a table that was never created.
 *
 * A missing table is reported loudly here rather than crashing, so one absent table
 * cannot take the whole site down. Checked with a trivial SELECT rather than
 * information_schema, which shared hosts often deny.
 */
async function verifySchema() {
    const missing = [];
    for (const table of EXPECTED_TABLES) {
        try {
            await db.execute(sql.raw(`SELECT 1 FROM \`${table}\` LIMIT 1`));
        }
        catch {
            missing.push(table);
        }
    }
    return missing;
}
/**
 * Runs any pending Drizzle migrations at startup, so deploying new API code
 * also updates the database schema with no manual phpMyAdmin step. Safe to run
 * every boot: already-applied migrations are skipped via __drizzle_migrations.
 *
 * The `drizzle/` folder ships alongside the compiled app (see make-deploy.sh).
 * This file lives at <root>/{src,dist}/db/migrate.* , so ../../drizzle resolves
 * to <root>/drizzle in both dev (tsx) and production (compiled).
 */
/**
 * Say out loud, once at boot, which production features are switched OFF because
 * their configuration is missing.
 *
 * These fail SILENTLY otherwise: no PAYMENTS_SECRET means pay-links cannot encrypt
 * and online payment is quietly dead; no SMTP_HOST means every invoice and reminder
 * "sends" to a log nobody reads; no VAPID keys means push does nothing. On shared
 * hosting a missing env var is easy to do and invisible until a client says an email
 * never arrived. A loud line in the boot log turns that into a five-second check.
 */
function checkConfig() {
    if (process.env.NODE_ENV !== 'production')
        return;
    const off = [];
    if (!process.env.PAYMENTS_SECRET)
        off.push('online payments + saved cards (PAYMENTS_SECRET unset)');
    if (!process.env.SMTP_HOST)
        off.push('outbound email: invoices, reminders, receipts, portal invites (SMTP_HOST unset)');
    if (!process.env.APP_URL)
        off.push('correct links in emails (APP_URL unset)');
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY)
        off.push('web push notifications (VAPID keys unset)');
    if (!process.env.CORS_ORIGIN)
        off.push('cross-origin browser access (CORS_ORIGIN unset; requests will be denied)');
    if (!process.env.JWT_SECRET)
        off.push('a STABLE session secret (JWT_SECRET unset; sessions drop on restart)');
    if (off.length) {
        // eslint-disable-next-line no-console
        console.warn('klippy-api CONFIG: these features are OFF until configured: ' + off.join('; '));
    }
    else {
        // eslint-disable-next-line no-console
        console.log('klippy-api config: all optional features configured.');
    }
}
export async function runMigrations() {
    const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
    await migrate(db, { migrationsFolder });
    checkConfig();
    const missing = await verifySchema();
    if (missing.length) {
        // eslint-disable-next-line no-console
        console.error(`klippy-api SCHEMA INCOMPLETE: ${missing.length} expected table(s) missing: ${missing.join(', ')}.\n` +
            'Migrations reported success, so they were almost certainly skipped rather than run.\n' +
            'Repair with deploy/repair-schema.sql, then check __drizzle_migrations for a row ' +
            'whose created_at sits ahead of the migrations that never ran.');
    }
}
//# sourceMappingURL=migrate.js.map