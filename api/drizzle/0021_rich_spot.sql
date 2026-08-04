ALTER TABLE `accounts` ADD `biz_address` varchar(500);--> statement-breakpoint
ALTER TABLE `accounts` ADD `biz_tax_number` varchar(60);--> statement-breakpoint
ALTER TABLE `accounts` ADD `biz_reg_number` varchar(60);--> statement-breakpoint
ALTER TABLE `accounts` ADD `bank_details` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `invoice_footer` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `invoice_accent` varchar(20) DEFAULT '#6366f1' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `default_tax_rate` decimal(5,2);--> statement-breakpoint
ALTER TABLE `accounts` ADD `default_due_days` int unsigned DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE `businesses` ADD `notes` text;