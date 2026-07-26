CREATE TABLE `deals` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`title` varchar(150) NOT NULL,
	`company` varchar(150),
	`contact_name` varchar(120),
	`contact_email` varchar(150),
	`contact_phone` varchar(40),
	`value` decimal(12,2) NOT NULL DEFAULT '0',
	`stage` enum('lead','contacted','proposal','won','lost') NOT NULL DEFAULT 'lead',
	`notes` text,
	`position` int unsigned NOT NULL DEFAULT 0,
	`client_folder_id` int unsigned,
	`won_at` datetime,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `folders` ADD `pillar` enum('delivery','operations') DEFAULT 'delivery' NOT NULL;--> statement-breakpoint
ALTER TABLE `deals` ADD CONSTRAINT `deals_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deals` ADD CONSTRAINT `deals_client_folder_id_folders_id_fk` FOREIGN KEY (`client_folder_id`) REFERENCES `folders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deals` ADD CONSTRAINT `deals_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_deals_account_stage` ON `deals` (`account_id`,`stage`,`position`);