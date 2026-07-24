CREATE TABLE `api_tokens` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	`name` varchar(80) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`last_used_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_api_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `board_teams` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`board_id` int unsigned NOT NULL,
	`team_id` int unsigned NOT NULL,
	CONSTRAINT `board_teams_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_board_team` UNIQUE(`board_id`,`team_id`)
);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`team_id` int unsigned NOT NULL,
	`user_id` int unsigned NOT NULL,
	CONSTRAINT `team_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_team_member` UNIQUE(`team_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`account_id` int unsigned NOT NULL,
	`name` varchar(80) NOT NULL,
	`color` varchar(20) NOT NULL DEFAULT '#6366f1',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `teams_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `recurrence` enum('none','daily','weekly','biweekly','monthly') DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `daily_digest` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_tokens_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `board_teams` ADD CONSTRAINT `board_teams_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `board_teams` ADD CONSTRAINT `board_teams_board_id_boards_id_fk` FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `board_teams` ADD CONSTRAINT `board_teams_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_team_id_teams_id_fk` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `teams` ADD CONSTRAINT `teams_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_api_tokens_account_user` ON `api_tokens` (`account_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_board_teams_account` ON `board_teams` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_team_members_account` ON `team_members` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_teams_account` ON `teams` (`account_id`);