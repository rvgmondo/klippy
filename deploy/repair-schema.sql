-- Klippy: bring a live database up to date by hand.
--
-- WHY THIS EXISTS
-- The app normally applies its own migrations on boot. On this server that stopped
-- happening after migration 0011, so `expenses`, `offerings` and `subscriptions`
-- were never created and anything touching them (Reports, Expenses, Offerings)
-- fails with "Table doesn't exist". Drizzle decides what to run by comparing each
-- migration's timestamp against the newest row in `__drizzle_migrations`, so one
-- row with a too-new timestamp makes it skip everything after it, silently.
--
-- Written for shared hosting: no information_schema lookups and no stored
-- procedures, because cPanel MySQL users are usually denied both.
--
-- ============================ PART 1 ============================
-- Safe to paste and run as a whole. "IF NOT EXISTS" means re-running does nothing.

CREATE TABLE IF NOT EXISTS `expenses` (
  `id` int unsigned AUTO_INCREMENT NOT NULL,
  `account_id` int unsigned NOT NULL,
  `business_id` int unsigned NOT NULL,
  `folder_id` int unsigned,
  `description` varchar(200) NOT NULL,
  `category` varchar(60),
  `amount` decimal(12,2) NOT NULL,
  `incurred_on` date NOT NULL,
  `created_by` int unsigned,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_expenses_account_business` (`account_id`,`business_id`,`incurred_on`),
  CONSTRAINT `expenses_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE,
  CONSTRAINT `expenses_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE CASCADE,
  CONSTRAINT `expenses_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE SET NULL,
  CONSTRAINT `expenses_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS `offerings` (
  `id` int unsigned AUTO_INCREMENT NOT NULL,
  `account_id` int unsigned NOT NULL,
  `business_id` int unsigned NOT NULL,
  `name` varchar(150) NOT NULL,
  `description` text,
  `price` decimal(12,2) NOT NULL DEFAULT '0',
  `cost` decimal(12,2),
  `unit` varchar(30),
  `recurring` boolean NOT NULL DEFAULT false,
  `stock_qty` int,
  `reorder_point` int,
  `active` boolean NOT NULL DEFAULT true,
  `position` int unsigned NOT NULL DEFAULT 0,
  `created_by` int unsigned,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_offerings_account_business` (`account_id`,`business_id`,`position`),
  CONSTRAINT `offerings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE,
  CONSTRAINT `offerings_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE CASCADE,
  CONSTRAINT `offerings_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS `subscriptions` (
  `id` int unsigned AUTO_INCREMENT NOT NULL,
  `account_id` int unsigned NOT NULL,
  `business_id` int unsigned NOT NULL,
  `offering_id` int unsigned NOT NULL,
  `folder_id` int unsigned NOT NULL,
  `status` enum('active','paused','canceled') NOT NULL DEFAULT 'active',
  `started_on` date NOT NULL,
  `next_bill_date` date NOT NULL,
  `last_billed_at` datetime,
  `created_by` int unsigned,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_subscriptions_account_status` (`account_id`,`status`,`next_bill_date`),
  CONSTRAINT `subscriptions_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE,
  CONSTRAINT `subscriptions_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE CASCADE,
  CONSTRAINT `subscriptions_offering_id_offerings_id_fk` FOREIGN KEY (`offering_id`) REFERENCES `offerings`(`id`) ON DELETE CASCADE,
  CONSTRAINT `subscriptions_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE CASCADE,
  CONSTRAINT `subscriptions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL
);

-- ============================ PART 2 ============================
-- Run these ONE AT A TIME. MySQL has no "ADD COLUMN IF NOT EXISTS", so if a column
-- is already there you get:
--     #1060 - Duplicate column name '...'
-- That is not a problem. It means that one was already applied: skip it and run the
-- next. Same for #1061 (duplicate key name) on the index.

-- ALTER TABLE `businesses` ADD `type` enum('services','products','code','content') NOT NULL DEFAULT 'services';

-- ALTER TABLE `businesses` ADD `secondary_types` json NOT NULL DEFAULT ('[]');

-- ALTER TABLE `tasks` ADD `estimate_minutes` int unsigned NULL;

-- ALTER TABLE `tasks` ADD `scheduled_start` datetime NULL;

-- CREATE INDEX `idx_tasks_account_scheduled` ON `tasks` (`account_id`,`scheduled_start`);

-- ALTER TABLE `users` MODIFY COLUMN `accent` varchar(20) NOT NULL DEFAULT 'lime';
