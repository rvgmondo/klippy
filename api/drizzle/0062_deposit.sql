ALTER TABLE `documents` ADD `deposit_type` enum('none','percent','amount') NOT NULL DEFAULT 'none';--> statement-breakpoint
ALTER TABLE `documents` ADD `deposit_value` decimal(12,2) NOT NULL DEFAULT '0';--> statement-breakpoint
ALTER TABLE `documents` ADD `deposit_amount` decimal(12,2) NOT NULL DEFAULT '0';
