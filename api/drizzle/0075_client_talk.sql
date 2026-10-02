CREATE TABLE `client_emails` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned,
	`folder_id` int unsigned NOT NULL,
	`to_emails` varchar(500) NOT NULL,
	`subject` varchar(200) NOT NULL,
	`body` text NOT NULL,
	`status` enum('sent','failed') NOT NULL DEFAULT 'sent',
	`error` varchar(255),
	`sent_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `client_emails_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `support_messages` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`request_id` int unsigned NOT NULL,
	`from_client` boolean NOT NULL,
	`author_name` varchar(150),
	`user_id` int unsigned,
	`body` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `support_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `support_requests` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`folder_id` int unsigned NOT NULL,
	`portal_user_id` int unsigned,
	`subject` varchar(200) NOT NULL,
	`status` enum('open','answered','closed') NOT NULL DEFAULT 'open',
	`task_id` int unsigned,
	`last_message_at` datetime NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `support_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `businesses` ADD `biz_whatsapp` varchar(20);--> statement-breakpoint
ALTER TABLE `client_emails` ADD CONSTRAINT `client_emails_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_emails` ADD CONSTRAINT `client_emails_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_emails` ADD CONSTRAINT `client_emails_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `client_emails` ADD CONSTRAINT `client_emails_sent_by_users_id_fk` FOREIGN KEY (`sent_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_messages` ADD CONSTRAINT `support_messages_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_messages` ADD CONSTRAINT `support_messages_request_id_support_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `support_requests`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_messages` ADD CONSTRAINT `support_messages_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_requests` ADD CONSTRAINT `support_requests_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_requests` ADD CONSTRAINT `support_requests_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_requests` ADD CONSTRAINT `support_requests_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_requests` ADD CONSTRAINT `support_requests_portal_user_id_portal_users_id_fk` FOREIGN KEY (`portal_user_id`) REFERENCES `portal_users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_requests` ADD CONSTRAINT `support_requests_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_client_emails_folder` ON `client_emails` (`account_id`,`folder_id`);--> statement-breakpoint
CREATE INDEX `idx_support_messages_request` ON `support_messages` (`account_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_support_account_status` ON `support_requests` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_support_folder` ON `support_requests` (`account_id`,`folder_id`);