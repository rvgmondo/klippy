-- Reconcile drizzle/meta with the database, so `npm run db:generate` works again.
--
-- Migrations 0063 to 0068 were written by hand and the meta snapshot was not kept in
-- step. drizzle-kit diffs schema.ts against the LAST SNAPSHOT, not the database, so the
-- diff it produced for this migration wanted to CREATE invitations and
-- recurring_expenses, ADD expenses.recurring_expense_id, and MODIFY three updated_at
-- columns. Every one of those already exists in the database (checked with
-- scripts/db-drift.mjs), and re-running them would fail on boot.
--
-- Two foreign keys carry older hand-chosen names (fk_hosting_subscription,
-- expenses_recurring_expense_id_fk). They are functionally identical to what the
-- snapshot now records and are left alone rather than dropped and re-added under
-- another name on a live table.
--
-- The ONE thing genuinely missing was the created_by foreign key on
-- payment_connections, which the hand-written 0065 omitted. It is added here, after
-- clearing any orphan first so the constraint cannot fail.
--
-- The 0069 snapshot beside this file was generated from schema.ts and is correct. From
-- here on, migrations come from `npm run db:generate` and drizzle/meta is not edited by
-- hand.
UPDATE `payment_connections` pc
  LEFT JOIN `users` u ON u.id = pc.created_by
  SET pc.created_by = NULL
  WHERE pc.created_by IS NOT NULL AND u.id IS NULL;
--> statement-breakpoint
ALTER TABLE `payment_connections`
  ADD CONSTRAINT `payment_connections_created_by_users_id_fk`
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
