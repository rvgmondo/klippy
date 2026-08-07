CREATE TABLE `portal_login_tokens` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`portal_user_id` int unsigned NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `portal_login_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_portal_token` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `portal_users` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`folder_id` int unsigned NOT NULL,
	`email` varchar(150) NOT NULL,
	`name` varchar(150),
	`password_hash` varchar(100),
	`is_active` boolean NOT NULL DEFAULT true,
	`last_login_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `portal_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_portal_user` UNIQUE(`folder_id`,`email`)
);
--> statement-breakpoint
ALTER TABLE `documents` ADD `decision` enum('accepted','declined');--> statement-breakpoint
ALTER TABLE `documents` ADD `decision_at` datetime;--> statement-breakpoint
ALTER TABLE `documents` ADD `decision_by` varchar(150);--> statement-breakpoint
ALTER TABLE `folders` ADD `billing_vat_number` varchar(60);--> statement-breakpoint
ALTER TABLE `folders` ADD `billing_address` text;--> statement-breakpoint
ALTER TABLE `portal_login_tokens` ADD CONSTRAINT `portal_login_tokens_portal_user_id_portal_users_id_fk` FOREIGN KEY (`portal_user_id`) REFERENCES `portal_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `portal_users` ADD CONSTRAINT `portal_users_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `portal_users` ADD CONSTRAINT `portal_users_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_portal_token_user` ON `portal_login_tokens` (`portal_user_id`);--> statement-breakpoint
CREATE INDEX `idx_portal_user_email` ON `portal_users` (`email`);