UPDATE `hosting_accounts` ha LEFT JOIN `subscriptions` s ON s.id = ha.subscription_id SET ha.subscription_id = NULL WHERE ha.subscription_id IS NOT NULL AND s.id IS NULL;--> statement-breakpoint
ALTER TABLE `hosting_accounts` MODIFY COLUMN `subscription_id` int unsigned NULL;--> statement-breakpoint
ALTER TABLE `hosting_accounts` ADD CONSTRAINT `fk_hosting_subscription` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;
