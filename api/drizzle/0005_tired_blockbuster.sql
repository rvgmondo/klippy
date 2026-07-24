CREATE TABLE `storage_nodes` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`parent_id` int unsigned,
	`kind` enum('folder','file') NOT NULL,
	`name` varchar(255) NOT NULL,
	`storage_key` varchar(255),
	`size` int unsigned,
	`mime_type` varchar(100),
	`uploaded_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `storage_nodes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `storage_nodes` ADD CONSTRAINT `storage_nodes_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `storage_nodes` ADD CONSTRAINT `storage_nodes_parent_id_storage_nodes_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `storage_nodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `storage_nodes` ADD CONSTRAINT `storage_nodes_uploaded_by_users_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_storage_account_parent` ON `storage_nodes` (`account_id`,`parent_id`,`kind`,`name`);