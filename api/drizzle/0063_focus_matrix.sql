CREATE TABLE `focus_items` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned,
	`kind` enum('manual','task','invoice','quote','deal') NOT NULL DEFAULT 'manual',
	`ref_id` int unsigned,
	`title` varchar(200),
	`important` boolean NOT NULL DEFAULT true,
	`due_date` date,
	`done_at` datetime,
	`position` int unsigned NOT NULL DEFAULT 0,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `focus_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_focus_ref` UNIQUE(`account_id`,`kind`,`ref_id`)
);
--> statement-breakpoint
ALTER TABLE `focus_items` ADD CONSTRAINT `focus_items_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `focus_items` ADD CONSTRAINT `focus_items_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `focus_items` ADD CONSTRAINT `focus_items_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_focus_account` ON `focus_items` (`account_id`,`done_at`);
