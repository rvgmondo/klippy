CREATE TABLE `social_accounts` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`network` enum('instagram','facebook','linkedin') NOT NULL,
	`external_id` varchar(120) NOT NULL,
	`display_name` varchar(150) NOT NULL,
	`avatar_url` varchar(500),
	`access_token_enc` text,
	`refresh_token_enc` text,
	`token_expires_at` datetime,
	`scopes` json,
	`status` enum('connected','expired','revoked','error') NOT NULL DEFAULT 'connected',
	`last_error` varchar(500),
	`last_checked_at` datetime,
	`connected_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_social_account` UNIQUE(`business_id`,`network`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `social_hashtag_sets` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`name` varchar(120) NOT NULL,
	`tags` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_hashtag_sets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `social_metrics` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`social_account_id` int unsigned NOT NULL,
	`target_id` int unsigned,
	`metric_date` date NOT NULL,
	`metric` varchar(60) NOT NULL,
	`value` bigint NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_metrics_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_social_metric` UNIQUE(`social_account_id`,`target_id`,`metric_date`,`metric`)
);
--> statement-breakpoint
CREATE TABLE `social_post_media` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`post_id` int unsigned NOT NULL,
	`storage_node_id` int unsigned NOT NULL,
	`position` int unsigned NOT NULL DEFAULT 0,
	`alt_text` varchar(500),
	`public_token` varchar(64) NOT NULL,
	`width` int unsigned,
	`height` int unsigned,
	`duration_ms` int unsigned,
	`mime_type` varchar(100),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_post_media_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_social_media_token` UNIQUE(`public_token`)
);
--> statement-breakpoint
CREATE TABLE `social_post_targets` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`post_id` int unsigned NOT NULL,
	`social_account_id` int unsigned NOT NULL,
	`network` enum('instagram','facebook','linkedin') NOT NULL,
	`caption_override` text,
	`status` enum('pending','publishing','published','failed','skipped','manual_done') NOT NULL DEFAULT 'pending',
	`external_post_id` varchar(200),
	`permalink` varchar(500),
	`error` varchar(500),
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`published_at` datetime,
	`next_attempt_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_post_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_social_post_target` UNIQUE(`post_id`,`social_account_id`)
);
--> statement-breakpoint
CREATE TABLE `social_posts` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`business_id` int unsigned NOT NULL,
	`folder_id` int unsigned,
	`title` varchar(200) NOT NULL,
	`caption` text,
	`first_comment` text,
	`post_type` enum('post','carousel','reel','story') NOT NULL DEFAULT 'post',
	`scheduled_at` datetime,
	`timezone` varchar(64),
	`status` enum('draft','needs_media','awaiting_approval','approved','scheduled','publishing','published','partially_published','failed','needs_manual','cancelled') NOT NULL DEFAULT 'draft',
	`delivery_mode` enum('auto','manual') NOT NULL DEFAULT 'auto',
	`media_ask` text,
	`media_ask_due` date,
	`approval_token` varchar(64),
	`approved_at` datetime,
	`approved_by_name` varchar(120),
	`created_by` int unsigned,
	`locked_at` datetime,
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_posts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_social_post_approval_token` UNIQUE(`approval_token`)
);
--> statement-breakpoint
CREATE TABLE `social_publish_log` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`post_id` int unsigned NOT NULL,
	`target_id` int unsigned,
	`level` enum('info','warn','error') NOT NULL DEFAULT 'info',
	`message` varchar(1000) NOT NULL,
	`payload` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_publish_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `timezone` varchar(64) DEFAULT 'Africa/Johannesburg' NOT NULL;--> statement-breakpoint
ALTER TABLE `social_accounts` ADD CONSTRAINT `social_accounts_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_accounts` ADD CONSTRAINT `social_accounts_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_accounts` ADD CONSTRAINT `social_accounts_connected_by_users_id_fk` FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_hashtag_sets` ADD CONSTRAINT `social_hashtag_sets_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_hashtag_sets` ADD CONSTRAINT `social_hashtag_sets_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_metrics` ADD CONSTRAINT `social_metrics_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_metrics` ADD CONSTRAINT `social_metrics_social_account_id_social_accounts_id_fk` FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_metrics` ADD CONSTRAINT `social_metrics_target_id_social_post_targets_id_fk` FOREIGN KEY (`target_id`) REFERENCES `social_post_targets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_post_media` ADD CONSTRAINT `social_post_media_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_post_media` ADD CONSTRAINT `social_post_media_post_id_social_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `social_posts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_post_media` ADD CONSTRAINT `social_post_media_storage_node_id_storage_nodes_id_fk` FOREIGN KEY (`storage_node_id`) REFERENCES `storage_nodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_post_targets` ADD CONSTRAINT `social_post_targets_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_post_targets` ADD CONSTRAINT `social_post_targets_post_id_social_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `social_posts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_post_targets` ADD CONSTRAINT `social_post_targets_social_account_id_social_accounts_id_fk` FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_posts` ADD CONSTRAINT `social_posts_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_posts` ADD CONSTRAINT `social_posts_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_posts` ADD CONSTRAINT `social_posts_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_posts` ADD CONSTRAINT `social_posts_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_publish_log` ADD CONSTRAINT `social_publish_log_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_publish_log` ADD CONSTRAINT `social_publish_log_post_id_social_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `social_posts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_publish_log` ADD CONSTRAINT `social_publish_log_target_id_social_post_targets_id_fk` FOREIGN KEY (`target_id`) REFERENCES `social_post_targets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_social_accounts_account` ON `social_accounts` (`account_id`,`business_id`);--> statement-breakpoint
CREATE INDEX `idx_social_hashtag_business` ON `social_hashtag_sets` (`account_id`,`business_id`);--> statement-breakpoint
CREATE INDEX `idx_social_metrics_account` ON `social_metrics` (`account_id`,`social_account_id`,`metric_date`);--> statement-breakpoint
CREATE INDEX `idx_social_media_post` ON `social_post_media` (`post_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_social_targets_post` ON `social_post_targets` (`post_id`);--> statement-breakpoint
CREATE INDEX `idx_social_targets_retry` ON `social_post_targets` (`account_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_social_posts_calendar` ON `social_posts` (`account_id`,`business_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_social_posts_due` ON `social_posts` (`account_id`,`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_social_log_post` ON `social_publish_log` (`post_id`,`created_at`);