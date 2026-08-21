ALTER TABLE `time_entries` ADD `billed_document_id` int unsigned;--> statement-breakpoint
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_billed_document_id_documents_id_fk` FOREIGN KEY (`billed_document_id`) REFERENCES `documents`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `folders` ADD `monthly_hours_budget` decimal(6,2);
