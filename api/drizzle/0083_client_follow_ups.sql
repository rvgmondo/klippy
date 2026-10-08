ALTER TABLE `businesses` ADD `quote_follow_up_days` int unsigned;--> statement-breakpoint
ALTER TABLE `businesses` ADD `monthly_statements` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `quote_nudged_at` datetime;