CREATE TABLE `calendar_feeds` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`name` varchar(80) NOT NULL,
	`url_enc` text NOT NULL,
	`url_host` varchar(120) NOT NULL,
	`last_synced_at` datetime,
	`last_error` varchar(255),
	`event_count` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `calendar_feeds_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `external_events` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`feed_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`uid` varchar(255) NOT NULL,
	`title` varchar(300) NOT NULL,
	`location` varchar(300),
	`start_at` datetime NOT NULL,
	`end_at` datetime,
	`all_day` boolean NOT NULL DEFAULT false,
	CONSTRAINT `external_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `calendar_feeds` ADD CONSTRAINT `calendar_feeds_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calendar_feeds` ADD CONSTRAINT `calendar_feeds_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_events` ADD CONSTRAINT `external_events_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_events` ADD CONSTRAINT `external_events_feed_id_calendar_feeds_id_fk` FOREIGN KEY (`feed_id`) REFERENCES `calendar_feeds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_calendar_feeds_user` ON `calendar_feeds` (`account_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_external_events_user_start` ON `external_events` (`account_id`,`user_id`,`start_at`);