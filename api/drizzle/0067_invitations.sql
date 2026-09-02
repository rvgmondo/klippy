-- Consent before conscription.
--
-- POST /users used to grant a membership to any existing Klippy login that had no
-- membership in ANOTHER workspace. A login with no memberships AT ALL satisfied that,
-- and that state is reachable in ordinary use: leaving your last workspace, or having
-- your workspace deleted, removes the membership rows and leaves the users row behind.
-- So an attacker could spin up a throwaway workspace, add such a person by email, and
-- then reset their password through PATCH, which only requires a membership here.
--
-- The fence is now "a login already in THIS workspace", and this table is the way in
-- for everyone else: an invitation the person accepts while signed in as themselves.
CREATE TABLE `invitations` (
  `id` int unsigned AUTO_INCREMENT NOT NULL,
  `account_id` int unsigned NOT NULL,
  `email` varchar(150) NOT NULL,
  `role` enum('admin','member') NOT NULL DEFAULT 'member',
  `token_hash` varchar(64) NOT NULL,
  `expires_at` datetime NOT NULL,
  `accepted_at` datetime,
  `revoked_at` datetime,
  `created_by` int unsigned,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `invitations_id` PRIMARY KEY(`id`),
  CONSTRAINT `uniq_invitation_token` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_account_id_accounts_id_fk`
  FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_created_by_users_id_fk`
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `idx_invitation_account` ON `invitations` (`account_id`,`email`);
