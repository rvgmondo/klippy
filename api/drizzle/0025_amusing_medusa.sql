CREATE TABLE `business_email` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`from_name` varchar(120),
	`from_email` varchar(150),
	`reply_to` varchar(150),
	`invoice_from_name` varchar(120),
	`invoice_from_email` varchar(150),
	`invoice_reply_to` varchar(150),
	`smtp_host` varchar(200),
	`smtp_port` int unsigned,
	`smtp_secure` boolean,
	`smtp_user` varchar(200),
	`smtp_pass_enc` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `business_email_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_business_email` UNIQUE(`business_id`)
);
--> statement-breakpoint
ALTER TABLE `business_email` ADD CONSTRAINT `business_email_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `business_email` ADD CONSTRAINT `business_email_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;