CREATE TABLE `notifications` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`kind` varchar(40) NOT NULL,
	`title` varchar(200) NOT NULL,
	`body` varchar(500),
	`url` varchar(300),
	`read_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_notifications_user` ON `notifications` (`account_id`,`user_id`,`read_at`,`id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `decision_ip` varchar(64);--> statement-breakpoint
ALTER TABLE `documents` ADD `decision_ua` varchar(255);
