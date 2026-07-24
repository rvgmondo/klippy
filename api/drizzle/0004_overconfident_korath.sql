ALTER TABLE `accounts` ADD `brand_name` varchar(80);--> statement-breakpoint
ALTER TABLE `accounts` ADD `logo_path` varchar(255);--> statement-breakpoint
ALTER TABLE `folders` ADD `image_path` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `theme` enum('system','dark','light') DEFAULT 'dark' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `accent` varchar(20) DEFAULT 'violet' NOT NULL;