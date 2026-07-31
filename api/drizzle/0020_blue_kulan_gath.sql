CREATE TABLE `job_runs` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(60) NOT NULL,
	`last_run_on` date,
	`last_status` enum('ok','failed'),
	`last_message` varchar(500),
	`last_run_at` datetime,
	`enabled` boolean NOT NULL DEFAULT true,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `job_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_job_runs_name` UNIQUE(`name`)
);
