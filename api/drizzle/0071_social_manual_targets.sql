ALTER TABLE `social_post_targets` DROP INDEX `uniq_social_post_target`;--> statement-breakpoint
ALTER TABLE `social_post_targets` DROP FOREIGN KEY `social_post_targets_social_account_id_social_accounts_id_fk`;
--> statement-breakpoint
ALTER TABLE `social_post_targets` MODIFY COLUMN `social_account_id` int unsigned;--> statement-breakpoint
ALTER TABLE `social_post_targets` ADD CONSTRAINT `uniq_social_post_target` UNIQUE(`post_id`,`network`);--> statement-breakpoint
ALTER TABLE `social_post_targets` ADD CONSTRAINT `social_post_targets_social_account_id_social_accounts_id_fk` FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON DELETE set null ON UPDATE no action;