-- Klippy v2: ONE-TIME reconcile so the app can self-manage its database.
-- Run this ONCE via phpMyAdmin (Import) on your live Klippy database, together
-- with deploying the auto-migrating API. After this, future updates need NO
-- database step at all - the app applies its own migrations on restart.
--
-- What it does:
--   1. Applies the 0001 schema (labels, task_labels, user password-reset columns)
--   2. Creates the migration-tracking table and marks 0000 + 0001 as already done
--      (your tables came from schema.sql, which left no migration record).

CREATE TABLE `labels` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`name` varchar(50) NOT NULL,
	`color` varchar(20) NOT NULL DEFAULT '#6366f1',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `labels_id` PRIMARY KEY(`id`)
);

CREATE TABLE `task_labels` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`task_id` int unsigned NOT NULL,
	`label_id` int unsigned NOT NULL,
	CONSTRAINT `task_labels_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_task_label` UNIQUE(`task_id`,`label_id`)
);

ALTER TABLE `users` ADD `reset_token_hash` varchar(255);
ALTER TABLE `users` ADD `reset_expires` datetime;
ALTER TABLE `labels` ADD CONSTRAINT `labels_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_labels` ADD CONSTRAINT `task_labels_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_labels` ADD CONSTRAINT `task_labels_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_labels` ADD CONSTRAINT `task_labels_label_id_labels_id_fk` FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON DELETE cascade ON UPDATE no action;
CREATE INDEX `idx_labels_account` ON `labels` (`account_id`);
CREATE INDEX `idx_task_labels_account_task` ON `task_labels` (`account_id`,`task_id`);
-- Migration bookkeeping (marks 0000 + 0001 applied) --------------------------
CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `hash` text NOT NULL,
  `created_at` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES
  ('fcc0e0274e4966a18b596c6a24da3c0e0c2a851c072cb5ba0f025f813fc74f40', 1784795588235),
  ('319a75c3cbd82e993142aa95d6fe3a0cbca2d3ba55a64cd302d504424fbdcbdc', 1784804860343);
