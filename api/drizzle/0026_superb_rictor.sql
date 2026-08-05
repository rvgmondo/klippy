ALTER TABLE `businesses` ADD `reminders_enabled` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `businesses` ADD `reminder_offsets` json;--> statement-breakpoint
ALTER TABLE `businesses` ADD `suspend_after_days` int unsigned;--> statement-breakpoint
ALTER TABLE `documents` ADD `suspended_at` datetime;