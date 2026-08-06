ALTER TABLE `documents` DROP INDEX `uniq_doc_number`;--> statement-breakpoint
ALTER TABLE `documents` MODIFY COLUMN `type` enum('quote','invoice','credit_note') NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `source_document_id` int unsigned;--> statement-breakpoint
ALTER TABLE `documents` ADD `client_vat_number` varchar(60);--> statement-breakpoint
ALTER TABLE `documents` ADD `discount_type` enum('none','percent','amount') DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `discount_value` decimal(12,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `discount_amount` decimal(12,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD CONSTRAINT `uniq_doc_number` UNIQUE(`account_id`,`business_id`,`type`,`seq`);