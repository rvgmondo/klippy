-- Klippy: bring a live database up to date by hand.
--
-- WHY THIS EXISTS
-- The app normally applies its own migrations on boot. On this server that stopped
-- happening somewhere after migration 0011: `businesses` exists but `expenses`,
-- `offerings` and `subscriptions` were never created, so anything touching them
-- (Reports, Expenses, Offerings) fails with "Table doesn't exist". Drizzle decides
-- what to run by comparing each migration's timestamp against the newest row in
-- `__drizzle_migrations`, so a single row with a too-new timestamp makes it skip
-- everything after it, silently and without failing the boot.
--
-- SAFE TO RUN: every statement checks first, so running it twice changes nothing
-- and it will not touch data. Paste the whole thing into phpMyAdmin > SQL.
--
-- Covers migrations 0012 through 0018.

-- ---------------------------------------------------------------- 0013: tables
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
  CONSTRAINT `expenses_id` PRIMARY KEY(`id`),
  KEY `idx_expenses_account_business` (`account_id`,`business_id`,`incurred_on`)
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
  CONSTRAINT `offerings_id` PRIMARY KEY(`id`),
  KEY `idx_offerings_account_business` (`account_id`,`business_id`,`position`)
);

-- ---------------------------------------------------------- 0015: subscriptions
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
  CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`),
  KEY `idx_subscriptions_account_status` (`account_id`,`status`,`next_bill_date`)
);

-- ------------------------------------------------------- guarded column adds
-- MySQL has no "ADD COLUMN IF NOT EXISTS", so each one is checked first.

-- 0014: expenses.folder_id (in case `expenses` already existed without it)
SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expenses' AND COLUMN_NAME = 'folder_id') = 0,
  'ALTER TABLE `expenses` ADD `folder_id` int unsigned NULL',
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 0012: businesses.type
SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'type') = 0,
  "ALTER TABLE `businesses` ADD `type` enum('services','products','code','content') NOT NULL DEFAULT 'services'",
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 0016: businesses.secondary_types
SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'secondary_types') = 0,
  "ALTER TABLE `businesses` ADD `secondary_types` json NOT NULL DEFAULT ('[]')",
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 0017: time blocking on cards
SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'estimate_minutes') = 0,
  'ALTER TABLE `tasks` ADD `estimate_minutes` int unsigned NULL',
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'scheduled_start') = 0,
  'ALTER TABLE `tasks` ADD `scheduled_start` datetime NULL',
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tasks' AND INDEX_NAME = 'idx_tasks_account_scheduled') = 0,
  'CREATE INDEX `idx_tasks_account_scheduled` ON `tasks` (`account_id`,`scheduled_start`)',
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 0018: new accounts default to the lime accent (safe to re-run)
ALTER TABLE `users` MODIFY COLUMN `accent` varchar(20) NOT NULL DEFAULT 'lime';

-- ------------------------------------------------------------ foreign keys
-- The app leans on ON DELETE CASCADE: removing a business is expected to take its
-- offerings, expenses and subscriptions with it. Without these you would be left
-- with orphaned rows pointing at a business that no longer exists.
DROP PROCEDURE IF EXISTS klippy_add_fk;
DELIMITER $$
CREATE PROCEDURE klippy_add_fk(
  IN t VARCHAR(64), IN fk VARCHAR(128), IN col VARCHAR(64),
  IN ref VARCHAR(64), IN refcol VARCHAR(64), IN onDelete VARCHAR(16))
BEGIN
  IF (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = t
          AND CONSTRAINT_NAME = fk AND CONSTRAINT_TYPE = 'FOREIGN KEY') = 0
     AND (SELECT COUNT(*) FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t) = 1 THEN
    SET @q := CONCAT('ALTER TABLE `', t, '` ADD CONSTRAINT `', fk,
                     '` FOREIGN KEY (`', col, '`) REFERENCES `', ref, '`(`', refcol,
                     '`) ON DELETE ', onDelete);
    PREPARE st FROM @q; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END $$
DELIMITER ;

CALL klippy_add_fk('expenses','expenses_account_id_accounts_id_fk','account_id','accounts','id','cascade');
CALL klippy_add_fk('expenses','expenses_business_id_businesses_id_fk','business_id','businesses','id','cascade');
CALL klippy_add_fk('expenses','expenses_folder_id_folders_id_fk','folder_id','folders','id','set null');
CALL klippy_add_fk('expenses','expenses_created_by_users_id_fk','created_by','users','id','set null');
CALL klippy_add_fk('offerings','offerings_account_id_accounts_id_fk','account_id','accounts','id','cascade');
CALL klippy_add_fk('offerings','offerings_business_id_businesses_id_fk','business_id','businesses','id','cascade');
CALL klippy_add_fk('offerings','offerings_created_by_users_id_fk','created_by','users','id','set null');
CALL klippy_add_fk('subscriptions','subscriptions_account_id_accounts_id_fk','account_id','accounts','id','cascade');
CALL klippy_add_fk('subscriptions','subscriptions_business_id_businesses_id_fk','business_id','businesses','id','cascade');
CALL klippy_add_fk('subscriptions','subscriptions_offering_id_offerings_id_fk','offering_id','offerings','id','cascade');
CALL klippy_add_fk('subscriptions','subscriptions_folder_id_folders_id_fk','folder_id','folders','id','cascade');
CALL klippy_add_fk('subscriptions','subscriptions_created_by_users_id_fk','created_by','users','id','set null');
DROP PROCEDURE IF EXISTS klippy_add_fk;

-- ------------------------------------------------------------------- check
-- Should list expenses, offerings and subscriptions.
SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('expenses','offerings','subscriptions')
 ORDER BY TABLE_NAME;
