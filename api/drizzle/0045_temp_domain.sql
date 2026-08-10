ALTER TABLE `hosting_accounts` ADD `is_temporary` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `hosting_accounts` ADD `temp_domain` varchar(190);--> statement-breakpoint
ALTER TABLE `hosting_accounts` ADD `domain_switched_at` datetime;--> statement-breakpoint
ALTER TABLE `hosting_settings` ADD `temp_domain_pattern` varchar(190);