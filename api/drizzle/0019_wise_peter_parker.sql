ALTER TABLE `documents` ADD `last_reminder_on` date;--> statement-breakpoint
ALTER TABLE `folders` ADD `billing_email` varchar(150);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `auto_send` boolean DEFAULT false NOT NULL;