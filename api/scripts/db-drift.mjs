/**
 * Does the live database match what schema.ts declares?
 *
 * drizzle-kit generate diffs schema.ts against the LAST SNAPSHOT in drizzle/meta, not
 * against the database. When migrations are written by hand and the snapshot is not
 * kept in step, the next generate emits SQL that re-creates things which already exist
 * and fails on boot. This script asks the database directly, so a reconciliation
 * migration can apply only what is genuinely missing.
 *
 * It reports foreign keys and ON UPDATE behaviour for the tables named on the command
 * line, or a default set. Read-only.
 *
 *   node scripts/db-drift.mjs sales payment_connections expenses
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const url = new URL(process.env.DATABASE_URL);
const db = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
});
const schema = url.pathname.slice(1);
const tables = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['sales', 'payment_connections', 'expenses', 'hosting_accounts', 'invitations', 'recurring_expenses', 'focus_items'];

console.log('=== foreign keys present ===');
const [fks] = await db.query(
  `SELECT TABLE_NAME t, CONSTRAINT_NAME c, COLUMN_NAME col, REFERENCED_TABLE_NAME rt
     FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_NAME IN (?)
    ORDER BY t, c`, [schema, tables]);
for (const r of fks) console.log(`${r.t.padEnd(20)} ${r.c.padEnd(58)} ${r.col} -> ${r.rt}`);
if (!fks.length) console.log('(none)');

console.log('\n=== updated_at extras (want: on update CURRENT_TIMESTAMP) ===');
const [cols] = await db.query(
  `SELECT TABLE_NAME t, EXTRA FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'updated_at' AND TABLE_NAME IN (?)`, [schema, tables]);
for (const r of cols) console.log(`${r.t.padEnd(20)} ${JSON.stringify(r.EXTRA)}`);

console.log('\n=== unique / plain indexes ===');
const [idx] = await db.query(
  `SELECT TABLE_NAME t, INDEX_NAME i, NON_UNIQUE nu, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) cols
     FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?) AND INDEX_NAME <> 'PRIMARY'
    GROUP BY t, i, nu ORDER BY t, i`, [schema, tables]);
for (const r of idx) console.log(`${r.t.padEnd(20)} ${r.i.padEnd(45)} ${r.nu ? 'index ' : 'UNIQUE'} (${r.cols})`);

await db.end();
