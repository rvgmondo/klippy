CREATE TABLE `hosting_accounts` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned,
	`subscription_id` int unsigned NOT NULL,
	`domain` varchar(190) NOT NULL,
	`username` varchar(32),
	`whm_package` varchar(60),
	`status` enum('pending','active','suspended','failed','dry-run') NOT NULL DEFAULT 'pending',
	`detail` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `hosting_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_hosting_subscription` UNIQUE(`subscription_id`)
);
--> statement-breakpoint
CREATE TABLE `hosting_settings` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL DEFAULT 0,
	`whm_host` varchar(190),
	`whm_user` varchar(60) DEFAULT 'root',
	`whm_token_enc` text,
	`allow_self_signed` boolean NOT NULL DEFAULT false,
	`enabled` boolean NOT NULL DEFAULT false,
	`live` boolean NOT NULL DEFAULT false,
	`suspend_after_days` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `hosting_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_hosting_settings_scope` UNIQUE(`account_id`,`business_id`)
);
--> statement-breakpoint
ALTER TABLE `offerings` ADD `provisioning` enum('none','cpanel') DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `offerings` ADD `whm_package` varchar(60);--> statement-breakpoint
ALTER TABLE `payment_settings` ADD `business_id` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `domain` varchar(190);--> statement-breakpoint
ALTER TABLE `payment_settings` ADD CONSTRAINT `uniq_payment_settings_scope` UNIQUE(`account_id`,`business_id`);--> statement-breakpoint
ALTER TABLE `payment_settings` DROP INDEX `uniq_payment_settings_account`;--> statement-breakpoint
ALTER TABLE `hosting_accounts` ADD CONSTRAINT `hosting_accounts_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `hosting_settings` ADD CONSTRAINT `hosting_settings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_hosting_account` ON `hosting_accounts` (`account_id`,`status`);