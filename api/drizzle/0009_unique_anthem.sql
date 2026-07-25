CREATE TABLE `payments` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`document_id` int unsigned NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`paid_on` date NOT NULL,
	`method` varchar(40),
	`note` varchar(255),
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_payments_account_doc` ON `payments` (`account_id`,`document_id`);