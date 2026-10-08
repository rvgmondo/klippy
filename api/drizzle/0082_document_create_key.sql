ALTER TABLE `documents` ADD `create_key` varchar(64);--> statement-breakpoint
ALTER TABLE `documents` ADD CONSTRAINT `uniq_doc_create_key` UNIQUE(`account_id`,`create_key`);