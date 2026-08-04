ALTER TABLE `businesses` ADD `brand_name` varchar(80);--> statement-breakpoint
ALTER TABLE `businesses` ADD `logo_path` varchar(255);--> statement-breakpoint
ALTER TABLE `businesses` ADD `biz_address` varchar(500);--> statement-breakpoint
ALTER TABLE `businesses` ADD `biz_tax_number` varchar(60);--> statement-breakpoint
ALTER TABLE `businesses` ADD `biz_reg_number` varchar(60);--> statement-breakpoint
ALTER TABLE `businesses` ADD `bank_details` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `invoice_footer` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `invoice_accent` varchar(20) DEFAULT '#6366f1' NOT NULL;--> statement-breakpoint
ALTER TABLE `businesses` ADD `default_tax_rate` decimal(5,2);--> statement-breakpoint
ALTER TABLE `businesses` ADD `default_due_days` int unsigned DEFAULT 14 NOT NULL;--> statement-breakpoint
UPDATE `businesses` b JOIN `accounts` a ON a.id = b.account_id SET b.brand_name = a.brand_name, b.logo_path = a.logo_path, b.biz_address = a.biz_address, b.biz_tax_number = a.biz_tax_number, b.biz_reg_number = a.biz_reg_number, b.bank_details = a.bank_details, b.invoice_footer = a.invoice_footer, b.invoice_accent = a.invoice_accent, b.default_tax_rate = a.default_tax_rate, b.default_due_days = a.default_due_days;
