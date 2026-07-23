import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db } from './client.js';

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
}
