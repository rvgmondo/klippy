CREATE TABLE `payment_connections` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`provider` enum('yoco') NOT NULL,
	`label` varchar(80),
	`secret_enc` text,
	`enabled` boolean NOT NULL DEFAULT true,
	`last_synced_at` datetime,
	`last_synced_through` date,
	`last_status` varchar(255),
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_payment_connection` UNIQUE(`account_id`,`business_id`,`provider`)
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`provider` enum('yoco','manual') NOT NULL DEFAULT 'manual',
	`external_id` varchar(80),
	`source` varchar(40),
	`terminal` varchar(80),
	`occurred_at` datetime NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'ZAR',
	`gross` decimal(12,2) NOT NULL,
	`fee` decimal(12,2) NOT NULL DEFAULT '0',
	`net` decimal(12,2) NOT NULL,
	`tip` decimal(12,2) NOT NULL DEFAULT '0',
	`refunded` decimal(12,2) NOT NULL DEFAULT '0',
	`tax_rate` decimal(5,2) NOT NULL DEFAULT '0',
	`tax_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`status` varchar(20) NOT NULL DEFAULT 'approved',
	`reference` varchar(120),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sales_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_sale_external` UNIQUE(`account_id`,`provider`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `payment_connections` ADD CONSTRAINT `payment_connections_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_connections` ADD CONSTRAINT `payment_connections_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_sales_account_date` ON `sales` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_sales_business_date` ON `sales` (`business_id`,`occurred_at`);
