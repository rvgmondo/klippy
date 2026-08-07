ALTER TABLE `portal_users` ADD `failed_attempts` int unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `portal_users` ADD `locked_until` datetime;--> statement-breakpoint
ALTER TABLE `portal_users` ADD `last_link_at` datetime;