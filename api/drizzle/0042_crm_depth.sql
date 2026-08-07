CREATE TABLE `contacts` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned,
	`name` varchar(120) NOT NULL,
	`email` varchar(150),
	`phone` varchar(40),
	`company` varchar(150),
	`role` varchar(80),
	`notes` text,
	`folder_id` int unsigned,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `deal_activities` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`deal_id` int unsigned NOT NULL,
	`kind` enum('note','call','email','meeting','stage') NOT NULL DEFAULT 'note',
	`body` text,
	`occurred_at` datetime NOT NULL,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deal_activities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `deals` ADD `contact_id` int unsigned;--> statement-breakpoint
ALTER TABLE `deals` ADD `source` varchar(60);--> statement-breakpoint
ALTER TABLE `deals` ADD `next_follow_up_at` date;--> statement-breakpoint
ALTER TABLE `deals` ADD `follow_up_note` varchar(200);--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deal_activities` ADD CONSTRAINT `deal_activities_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deal_activities` ADD CONSTRAINT `deal_activities_deal_id_deals_id_fk` FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deal_activities` ADD CONSTRAINT `deal_activities_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_contacts_account_business` ON `contacts` (`account_id`,`business_id`);--> statement-breakpoint
CREATE INDEX `idx_contacts_email` ON `contacts` (`account_id`,`email`);--> statement-breakpoint
CREATE INDEX `idx_deal_activities` ON `deal_activities` (`account_id`,`deal_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_deals_followup` ON `deals` (`account_id`,`next_follow_up_at`);
--> statement-breakpoint
-- Give every existing deal that has a name a contact record, and link it. Done in
-- the migration rather than lazily in the app so the pipeline is not half on the
-- old model and half on the new one, which is the state that produces duplicates.
INSERT INTO `contacts` (`account_id`, `business_id`, `name`, `email`, `phone`, `company`, `created_at`, `updated_at`)
SELECT `account_id`, `business_id`, `contact_name`, `contact_email`, `contact_phone`, `company`, NOW(), NOW()
  FROM `deals`
 WHERE `contact_name` IS NOT NULL AND `contact_name` <> '';
--> statement-breakpoint
UPDATE `deals` d
  JOIN `contacts` c
    ON c.`account_id` = d.`account_id`
   AND c.`name` = d.`contact_name`
   AND (c.`email` <=> d.`contact_email`)
   AND (c.`business_id` <=> d.`business_id`)
   SET d.`contact_id` = c.`id`
 WHERE d.`contact_name` IS NOT NULL AND d.`contact_name` <> '' AND d.`contact_id` IS NULL;
