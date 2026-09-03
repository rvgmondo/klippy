-- Costs that repeat, recorded once.
--
-- Expenses were one-off only, so rent, salaries, software, insurance and every other
-- standing cost had to be typed in again every month or they simply never appeared.
-- Nobody does that twelve times a year, which meant the cost side of every report was
-- quietly understated and "profit" read better than the bank did.
--
-- This is deliberately NOT a copy of the subscriptions table. That one bills a client
-- and raises an invoice. This one only remembers a cost and writes an ordinary expense
-- row on schedule, so every report that already reads expenses picks it up with no
-- further change.
CREATE TABLE `recurring_expenses` (
  `id` int unsigned AUTO_INCREMENT NOT NULL,
  `account_id` int unsigned NOT NULL,
  `business_id` int unsigned NOT NULL,
  `description` varchar(200) NOT NULL,
  `category` varchar(60),
  `amount` decimal(12,2) NOT NULL,
  `vat_amount` decimal(12,2),
  `interval_months` int unsigned NOT NULL DEFAULT 1,
  `next_due_on` date NOT NULL,
  `started_on` date NOT NULL,
  `ends_on` date,
  `is_active` boolean NOT NULL DEFAULT true,
  `last_generated_on` date,
  `created_by` int unsigned,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `recurring_expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `recurring_expenses` ADD CONSTRAINT `recurring_expenses_account_id_accounts_id_fk`
  FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `recurring_expenses` ADD CONSTRAINT `recurring_expenses_business_id_businesses_id_fk`
  FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `recurring_expenses` ADD CONSTRAINT `recurring_expenses_created_by_users_id_fk`
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `idx_recurring_expense_due` ON `recurring_expenses` (`is_active`,`next_due_on`);
--> statement-breakpoint
-- Which standing cost produced an expense row. Nullable, because most expenses are
-- still typed in by hand, and it is what stops a re-run writing the same month twice.
ALTER TABLE `expenses` ADD COLUMN `recurring_expense_id` int unsigned;
--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_recurring_expense_id_fk`
  FOREIGN KEY (`recurring_expense_id`) REFERENCES `recurring_expenses`(`id`) ON DELETE set null;
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_expense_recurrence_period` ON `expenses` (`recurring_expense_id`,`incurred_on`);
