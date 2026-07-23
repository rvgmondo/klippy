CREATE TABLE `labels` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`name` varchar(50) NOT NULL,
	`color` varchar(20) NOT NULL DEFAULT '#6366f1',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `labels_id` PRIMARY KEY(`id`)
);

CREATE TABLE `task_labels` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`task_id` int unsigned NOT NULL,
	`label_id` int unsigned NOT NULL,
	CONSTRAINT `task_labels_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_task_label` UNIQUE(`task_id`,`label_id`)
);

ALTER TABLE `users` ADD `reset_token_hash` varchar(255);
ALTER TABLE `users` ADD `reset_expires` datetime;
ALTER TABLE `labels` ADD CONSTRAINT `labels_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_labels` ADD CONSTRAINT `task_labels_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_labels` ADD CONSTRAINT `task_labels_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;
ALTER TABLE `task_labels` ADD CONSTRAINT `task_labels_label_id_labels_id_fk` FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON DELETE cascade ON UPDATE no action;
CREATE INDEX `idx_labels_account` ON `labels` (`account_id`);
CREATE INDEX `idx_task_labels_account_task` ON `task_labels` (`account_id`,`task_id`);