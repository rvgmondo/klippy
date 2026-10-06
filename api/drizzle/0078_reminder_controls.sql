CREATE TABLE `invoice_reminders` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`document_id` int unsigned NOT NULL,
	`kind` enum('reminder','final','chase') NOT NULL,
	`channels` varchar(60) NOT NULL,
	`sent_to` varchar(150),
	`amount` decimal(12,2),
	`sent_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoice_reminders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `documents` ADD `reminders_paused` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `next_reminder_on` date;--> statement-breakpoint
ALTER TABLE `folders` ADD `reminders_paused` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice_reminders` ADD CONSTRAINT `invoice_reminders_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_reminders` ADD CONSTRAINT `invoice_reminders_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_reminders` ADD CONSTRAINT `invoice_reminders_sent_by_users_id_fk` FOREIGN KEY (`sent_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_invoice_reminders_doc` ON `invoice_reminders` (`account_id`,`document_id`);