ALTER TABLE `folders` ADD `legal_name` varchar(200);--> statement-breakpoint
ALTER TABLE `folders` ADD `reg_number` varchar(60);--> statement-breakpoint
ALTER TABLE `folders` ADD `company_type` varchar(60);--> statement-breakpoint
ALTER TABLE `folders` ADD `country` varchar(2);--> statement-breakpoint
ALTER TABLE `folders` ADD `tax_number` varchar(60);--> statement-breakpoint
ALTER TABLE `folders` ADD `industry` varchar(80);--> statement-breakpoint
ALTER TABLE `folders` ADD `website` varchar(255);--> statement-breakpoint
ALTER TABLE `folders` ADD `bbbee_level` varchar(20);--> statement-breakpoint
ALTER TABLE `folders` ADD `financial_year_end` varchar(5);--> statement-breakpoint
ALTER TABLE `folders` ADD `payment_terms_days` int unsigned;--> statement-breakpoint
ALTER TABLE `folders` ADD `credit_limit` decimal(12,2);--> statement-breakpoint
ALTER TABLE `folders` ADD `currency` varchar(3);--> statement-breakpoint
ALTER TABLE `folders` ADD `client_status` enum('prospect','active','dormant','former') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `client_since` date;--> statement-breakpoint
ALTER TABLE `folders` ADD `account_manager_id` int unsigned;--> statement-breakpoint
ALTER TABLE `folders` ADD `source` varchar(80);--> statement-breakpoint
ALTER TABLE `folders` ADD `primary_contact_id` int unsigned;--> statement-breakpoint
ALTER TABLE `folders` ADD CONSTRAINT `folders_account_manager_id_users_id_fk` FOREIGN KEY (`account_manager_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `folders` ADD CONSTRAINT `folders_primary_contact_id_contacts_id_fk` FOREIGN KEY (`primary_contact_id`) REFERENCES `contacts`(`id`) ON DELETE set null ON UPDATE no action;