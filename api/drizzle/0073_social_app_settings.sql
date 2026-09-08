CREATE TABLE `social_app_settings` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`provider` enum('meta','linkedin') NOT NULL,
	`app_id` varchar(120),
	`app_secret_enc` text,
	`config_id` varchar(120),
	`updated_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_app_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_social_app_settings` UNIQUE(`account_id`,`provider`)
);
--> statement-breakpoint
ALTER TABLE `social_app_settings` ADD CONSTRAINT `social_app_settings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_app_settings` ADD CONSTRAINT `social_app_settings_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;