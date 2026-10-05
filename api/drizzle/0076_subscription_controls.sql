ALTER TABLE `subscriptions` ADD `billing_day` int unsigned;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `ends_on` date;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `notes` text;