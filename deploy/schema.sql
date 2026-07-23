CREATE TABLE `accounts` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(150) NOT NULL,
	`slug` varchar(80) NOT NULL,
	`plan` enum('free','pro','business') NOT NULL DEFAULT 'free',
	`status` enum('active','suspended') NOT NULL DEFAULT 'active',
	`folder_label_singular` varchar(40) NOT NULL DEFAULT 'Client',
	`folder_label_plural` varchar(40) NOT NULL DEFAULT 'Clients',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	CONSTRAINT `accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_accounts_slug` UNIQUE(`slug`)
);

CREATE TABLE `board_columns` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`board_id` int unsigned NOT NULL,
	`name` varchar(100) NOT NULL,
	`position` int unsigned NOT NULL DEFAULT 0,
	`color` varchar(20) NOT NULL DEFAULT '#94a3b8',
	`is_done_column` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `board_columns_id` PRIMARY KEY(`id`)
);

CREATE TABLE `boards` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`folder_id` int unsigned NOT NULL,
	`name` varchar(150) NOT NULL,
	`description` varchar(255),
	`is_archived` boolean NOT NULL DEFAULT false,
	`position` int unsigned NOT NULL DEFAULT 0,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `boards_id` PRIMARY KEY(`id`)
);

CREATE TABLE `focus_sessions` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`task_id` int unsigned,
	`label` varchar(200),
	`planned_seconds` int unsigned,
	`start_time` datetime NOT NULL,
	`end_time` datetime,
	`duration_seconds` int unsigned,
	`status` enum('running','completed','cancelled') NOT NULL DEFAULT 'running',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `focus_sessions_id` PRIMARY KEY(`id`)
);

CREATE TABLE `folders` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`parent_id` int unsigned,
	`name` varchar(150) NOT NULL,
	`color` varchar(20) NOT NULL DEFAULT '#6366f1',
	`notes` text,
	`is_archived` boolean NOT NULL DEFAULT false,
	`position` int unsigned NOT NULL DEFAULT 0,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `folders_id` PRIMARY KEY(`id`)
);

CREATE TABLE `task_comments` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`task_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`comment` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `task_comments_id` PRIMARY KEY(`id`)
);

CREATE TABLE `task_files` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`task_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`original_name` varchar(255) NOT NULL,
	`stored_name` varchar(255) NOT NULL,
	`filesize` int unsigned NOT NULL,
	`mime_type` varchar(100) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `task_files_id` PRIMARY KEY(`id`)
);

CREATE TABLE `task_subtasks` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`task_id` int unsigned NOT NULL,
	`title` varchar(200) NOT NULL,
	`is_completed` boolean NOT NULL DEFAULT false,
	`position` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `task_subtasks_id` PRIMARY KEY(`id`)
);

CREATE TABLE `tasks` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`board_id` int unsigned NOT NULL,
	`column_id` int unsigned NOT NULL,
	`title` varchar(200) NOT NULL,
	`description` text,
	`priority` enum('none','low','medium','high','urgent') NOT NULL DEFAULT 'none',
	`due_date` date,
	`assigned_to` int unsigned,
	`position` int unsigned NOT NULL DEFAULT 0,
	`is_completed` boolean NOT NULL DEFAULT false,
	`completed_at` datetime,
	`is_archived` boolean NOT NULL DEFAULT false,
	`created_by` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);

CREATE TABLE `time_entries` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`task_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`start_time` datetime NOT NULL,
	`end_time` datetime,
	`duration_seconds` int unsigned,
	`note` varchar(255),
	`is_manual` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `time_entries_id` PRIMARY KEY(`id`)
);

CREATE TABLE `users` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`name` varchar(100) NOT NULL,
	`email` varchar(150) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`role` enum('owner','admin','member') NOT NULL DEFAULT 'member',
	`is_active` boolean NOT NULL DEFAULT true,
	`failed_attempts` int unsigned NOT NULL DEFAULT 0,
	`locked_until` datetime,
	`last_login` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_users_account_email` UNIQUE(`account_id`,`email`)
);

ALTER TABLE `board_columns` ADD CONSTRAINT `board_columns_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `board_columns` ADD CONSTRAINT `board_columns_board_id_boards_id_fk` FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `boards` ADD CONSTRAINT `boards_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `boards` ADD CONSTRAINT `boards_folder_id_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `boards` ADD CONSTRAINT `boards_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
ALTER TABLE `focus_sessions` ADD CONSTRAINT `focus_sessions_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `focus_sessions` ADD CONSTRAINT `focus_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `focus_sessions` ADD CONSTRAINT `focus_sessions_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE set null ON UPDATE no action;
ALTER TABLE `folders` ADD CONSTRAINT `folders_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `folders` ADD CONSTRAINT `folders_parent_id_folders_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `folders`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `folders` ADD CONSTRAINT `folders_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_comments` ADD CONSTRAINT `task_comments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_files` ADD CONSTRAINT `task_files_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_files` ADD CONSTRAINT `task_files_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_files` ADD CONSTRAINT `task_files_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_subtasks` ADD CONSTRAINT `task_subtasks_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_subtasks` ADD CONSTRAINT `task_subtasks_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_board_id_boards_id_fk` FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_column_id_board_columns_id_fk` FOREIGN KEY (`column_id`) REFERENCES `board_columns`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assigned_to_users_id_fk` FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `time_entries` ADD CONSTRAINT `time_entries_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `users` ADD CONSTRAINT `users_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
CREATE INDEX `idx_columns_account_board` ON `board_columns` (`account_id`,`board_id`,`position`);
CREATE INDEX `idx_boards_account_folder` ON `boards` (`account_id`,`folder_id`,`position`);
CREATE INDEX `idx_focus_account_user` ON `focus_sessions` (`account_id`,`user_id`,`status`);
CREATE INDEX `idx_folders_account_parent` ON `folders` (`account_id`,`parent_id`,`position`);
CREATE INDEX `idx_comments_account_task` ON `task_comments` (`account_id`,`task_id`);
CREATE INDEX `idx_files_account_task` ON `task_files` (`account_id`,`task_id`);
CREATE INDEX `idx_subtasks_account_task` ON `task_subtasks` (`account_id`,`task_id`,`position`);
CREATE INDEX `idx_tasks_account_column` ON `tasks` (`account_id`,`column_id`,`position`);
CREATE INDEX `idx_tasks_account_board` ON `tasks` (`account_id`,`board_id`);
CREATE INDEX `idx_tasks_account_due` ON `tasks` (`account_id`,`due_date`);
CREATE INDEX `idx_time_account_task` ON `time_entries` (`account_id`,`task_id`);
CREATE INDEX `idx_time_account_user_open` ON `time_entries` (`account_id`,`user_id`,`end_time`);