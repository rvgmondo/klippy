ALTER TABLE `folders` ADD `deleted_at` datetime;--> statement-breakpoint
ALTER TABLE `boards` ADD `deleted_at` datetime;--> statement-breakpoint
ALTER TABLE `users` ADD `session_epoch` int unsigned NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret_enc` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled_at` datetime;
