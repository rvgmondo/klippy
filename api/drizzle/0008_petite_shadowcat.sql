CREATE TABLE `document_lines` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`document_id` int unsigned NOT NULL,
	`description` varchar(500) NOT NULL,
	`quantity` decimal(10,2) NOT NULL DEFAULT '1',
	`unit_price` decimal(12,2) NOT NULL DEFAULT '0',
	`amount` decimal(12,2) NOT NULL DEFAULT '0',
	`position` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `document_lines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`type` enum('quote','invoice') NOT NULL,
	`seq` int unsigned NOT NULL,
	`number` varchar(30) NOT NULL,
	`folder_id` int unsigned,
	`client_name` varchar(150) NOT NULL,
	`client_email` varchar(150),
	`client_address` text,
	`issue_date` date NOT NULL,
	`due_date` date,
	`status` enum('draft','sent','accepted','paid','void') NOT NULL DEFAULT 'draft',
	`currency` varchar(3) NOT NULL DEFAULT 'ZAR',
	`tax_rate` decimal(5,2) NOT NULL DEFAULT '0',
	`subtotal` decimal(12,2) NOT NULL DEFAULT '0',
	`tax_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`total` decimal(12,2) NOT NULL DEFAULT '0',
	`notes` text,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_doc_number` UNIQUE(`account_id`,`type`,`seq`)
);
--> statement-breakpoint
ALTER TABLE `document_lines` ADD CONSTRAINT `document_lines_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `document_lines` ADD CONSTRAINT `document_lines_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `documents` ADD CONSTRAINT `documents_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `documents` ADD CONSTRAINT `documents_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `documents` ADD CONSTRAINT `documents_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_doclines_account_doc` ON `document_lines` (`account_id`,`document_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_docs_account_type` ON `documents` (`account_id`,`type`,`created_at`);