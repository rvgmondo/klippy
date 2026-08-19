ALTER TABLE `payments` ADD `pf_payment_id` varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_payments_pf` ON `payments` (`pf_payment_id`);
