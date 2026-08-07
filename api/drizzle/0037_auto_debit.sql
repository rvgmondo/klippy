CREATE TABLE `auto_debit_attempts` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`subscription_id` int unsigned NOT NULL,
	`document_id` int unsigned NOT NULL,
	`status` enum('pending','charged','failed','skipped','dry-run') NOT NULL DEFAULT 'pending',
	`amount` decimal(12,2) NOT NULL,
	`detail` text,
	`pf_payment_id` varchar(60),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `auto_debit_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_auto_debit_document` UNIQUE(`document_id`)
);
--> statement-breakpoint
ALTER TABLE `documents` ADD `subscription_id` int unsigned;--> statement-breakpoint
ALTER TABLE `payment_settings` ADD `auto_debit_enabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_settings` ADD `auto_debit_live` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_settings` ADD `auto_debit_max` decimal(12,2) DEFAULT '5000.00' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `auto_debit` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `auto_debit_attempts` ADD CONSTRAINT `auto_debit_attempts_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_auto_debit_account` ON `auto_debit_attempts` (`account_id`,`created_at`);