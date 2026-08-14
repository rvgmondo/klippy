CREATE INDEX `idx_docs_account_folder` ON `documents` (`account_id`,`folder_id`);--> statement-breakpoint
CREATE INDEX `idx_docs_account_subscription` ON `documents` (`account_id`,`subscription_id`);