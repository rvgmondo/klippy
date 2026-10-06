ALTER TABLE `businesses` ADD `quote_valid_days` int unsigned DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `businesses` ADD `quote_deposit_percent` decimal(5,2);--> statement-breakpoint
ALTER TABLE `businesses` ADD `quote_footer` text;--> statement-breakpoint
ALTER TABLE `businesses` ADD `quote_show_bank` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `businesses` ADD `credit_note_footer` text;