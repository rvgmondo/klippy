ALTER TABLE `hosting_accounts` ADD `warned_at` datetime;--> statement-breakpoint
ALTER TABLE `hosting_accounts` ADD `suspended_at` datetime;--> statement-breakpoint
ALTER TABLE `hosting_settings` ADD `warn_before_days` int DEFAULT 3;