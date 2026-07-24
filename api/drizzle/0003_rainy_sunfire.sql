CREATE TABLE `memberships` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`role` enum('owner','admin','member') NOT NULL DEFAULT 'member',
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `memberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_membership` UNIQUE(`account_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `memberships` ADD CONSTRAINT `memberships_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memberships` ADD CONSTRAINT `memberships_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_memberships_user` ON `memberships` (`user_id`);--> statement-breakpoint
INSERT INTO `memberships` (`account_id`, `user_id`, `role`, `is_active`) SELECT `account_id`, `id`, `role`, `is_active` FROM `users`;--> statement-breakpoint
ALTER TABLE `users` DROP FOREIGN KEY `users_account_id_accounts_id_fk`;--> statement-breakpoint
ALTER TABLE `users` DROP INDEX `uniq_users_account_email`;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `uniq_users_email` UNIQUE(`email`);--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `account_id`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `role`;
