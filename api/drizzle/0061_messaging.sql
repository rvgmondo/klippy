ALTER TABLE `folders` ADD `billing_phone` varchar(40);--> statement-breakpoint
CREATE TABLE `messaging_settings` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL DEFAULT 0,
	`sms_provider` varchar(20) NOT NULL DEFAULT 'none',
	`sms_token_id` varchar(120),
	`sms_token_secret_enc` text,
	`sms_sender` varchar(20),
	`wa_phone_number_id` varchar(40),
	`wa_access_token_enc` text,
	`wa_template_name` varchar(100),
	`wa_template_lang` varchar(10) NOT NULL DEFAULT 'en',
	`remind_by_sms` boolean NOT NULL DEFAULT false,
	`remind_by_whatsapp` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `messaging_settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `messaging_settings` ADD CONSTRAINT `messaging_settings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_messaging_settings_scope` ON `messaging_settings` (`account_id`,`business_id`);
