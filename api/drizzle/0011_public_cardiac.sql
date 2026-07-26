CREATE TABLE `businesses` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`name` varchar(150) NOT NULL,
	`color` varchar(20) NOT NULL DEFAULT '#6366f1',
	`position` int unsigned NOT NULL DEFAULT 0,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `businesses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `deals` ADD `business_id` int unsigned;--> statement-breakpoint
ALTER TABLE `documents` ADD `business_id` int unsigned;--> statement-breakpoint
ALTER TABLE `folders` ADD `business_id` int unsigned;--> statement-breakpoint
ALTER TABLE `businesses` ADD CONSTRAINT `businesses_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `businesses` ADD CONSTRAINT `businesses_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_businesses_account` ON `businesses` (`account_id`,`position`);--> statement-breakpoint
ALTER TABLE `deals` ADD CONSTRAINT `deals_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `documents` ADD CONSTRAINT `documents_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `folders` ADD CONSTRAINT `folders_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO `businesses` (`account_id`, `name`, `position`) SELECT `id`, `name`, 0 FROM `accounts`;--> statement-breakpoint
UPDATE `folders` f JOIN `businesses` b ON b.`account_id` = f.`account_id` SET f.`business_id` = b.`id` WHERE f.`business_id` IS NULL;--> statement-breakpoint
UPDATE `deals` d JOIN `businesses` b ON b.`account_id` = d.`account_id` SET d.`business_id` = b.`id` WHERE d.`business_id` IS NULL;--> statement-breakpoint
UPDATE `documents` dc JOIN `businesses` b ON b.`account_id` = dc.`account_id` SET dc.`business_id` = b.`id` WHERE dc.`business_id` IS NULL;