ALTER TABLE `tasks` ADD `estimate_minutes` int unsigned;--> statement-breakpoint
ALTER TABLE `tasks` ADD `scheduled_start` datetime;--> statement-breakpoint
CREATE INDEX `idx_tasks_account_scheduled` ON `tasks` (`account_id`,`scheduled_start`);