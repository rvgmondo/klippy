ALTER TABLE `businesses` ADD `prefix_invoice` varchar(12);--> statement-breakpoint
ALTER TABLE `businesses` ADD `prefix_quote` varchar(12);--> statement-breakpoint
ALTER TABLE `businesses` ADD `prefix_credit_note` varchar(12);--> statement-breakpoint
ALTER TABLE `businesses` ADD `seq_start_invoice` int unsigned;--> statement-breakpoint
ALTER TABLE `businesses` ADD `seq_start_quote` int unsigned;--> statement-breakpoint
ALTER TABLE `businesses` ADD `seq_start_credit_note` int unsigned;