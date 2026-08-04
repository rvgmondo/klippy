CREATE TABLE `payment_settings` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`provider` varchar(20) NOT NULL DEFAULT 'payfast',
	`merchant_id` varchar(40),
	`merchant_key_enc` text,
	`passphrase_enc` text,
	`sandbox` boolean NOT NULL DEFAULT true,
	`enabled` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_payment_settings_account` UNIQUE(`account_id`)
);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `payfast_token` varchar(100);--> statement-breakpoint
ALTER TABLE `payment_settings` ADD CONSTRAINT `payment_settings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;