import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db } from './client.js';

/**
 * Every table the app expects to exist once migrations have run. Adding a table to
 * the schema means adding it here too.
 */
const EXPECTED_TABLES = [
  'accounts', 'users', 'memberships', 'businesses', 'folders', 'boards',
  'board_columns', 'tasks', 'time_entries', 'task_subtasks', 'task_comments',
  'task_files', 'labels', 'task_labels', 'teams', 'team_members', 'board_teams',
  'api_tokens', 'storage_nodes', 'product_notes', 'documents', 'document_lines',
  'payments', 'deals', 'push_subscriptions', 'offerings', 'expenses', 'subscriptions',
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
async function verifySchema(): Promise<string[]> {
  const missing: string[] = [];
  for (const table of EXPECTED_TABLES) {
    try {
      await db.execute(sql.raw(`SELECT 1 FROM \`${table}\` LIMIT 1`));
    } catch {
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
export async function runMigrations(): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  await migrate(db, { migrationsFolder });

  const missing = await verifySchema();
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(
      `klippy-api SCHEMA INCOMPLETE: ${missing.length} expected table(s) missing: ${missing.join(', ')}.\n` +
      'Migrations reported success, so they were almost certainly skipped rather than run.\n' +
      'Repair with deploy/repair-schema.sql, then check __drizzle_migrations for a row ' +
      'whose created_at sits ahead of the migrations that never ran.',
    );
  }
}
