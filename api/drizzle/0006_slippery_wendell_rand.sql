CREATE TABLE `product_notes` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`title` varchar(200) NOT NULL,
	`body` text,
	`kind` enum('idea','bug','improvement','question') NOT NULL DEFAULT 'idea',
	`status` enum('open','planned','done','dropped') NOT NULL DEFAULT 'open',
	`priority` enum('low','medium','high') NOT NULL DEFAULT 'medium',
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `currency` varchar(3) DEFAULT 'ZAR' NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `hourly_rate` decimal(10,2);--> statement-breakpoint
ALTER TABLE `product_notes` ADD CONSTRAINT `product_notes_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_notes` ADD CONSTRAINT `product_notes_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_notes_account_status` ON `product_notes` (`account_id`,`status`,`created_at`);