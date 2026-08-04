CREATE TABLE `business_members` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`role` enum('admin','member','viewer') NOT NULL DEFAULT 'member',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_business_member` UNIQUE(`business_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `business_members` ADD CONSTRAINT `business_members_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `business_members` ADD CONSTRAINT `business_members_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `business_members` ADD CONSTRAINT `business_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_business_members_user` ON `business_members` (`account_id`,`user_id`);