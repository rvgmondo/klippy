-- The first backfill only caught deals with a contact NAME. A deal that has an
-- email or a company but no person's name is still a lead worth keeping, and
-- dropping it silently is how a CRM starts out already missing things.
--
-- Named by whatever is actually known, in order of usefulness: the person, then
-- the company, then the email. Kept separate from 0042 rather than edited into it,
-- because 0042 has already run and rewriting an applied migration means the file
-- and the database disagree about what happened.
INSERT INTO `contacts` (`account_id`, `business_id`, `name`, `email`, `phone`, `company`, `created_at`, `updated_at`)
SELECT d.`account_id`, d.`business_id`,
       COALESCE(NULLIF(d.`contact_name`, ''), NULLIF(d.`company`, ''), d.`contact_email`),
       d.`contact_email`, d.`contact_phone`, d.`company`, NOW(), NOW()
  FROM `deals` d
 WHERE d.`contact_id` IS NULL
   AND (
     (d.`contact_email` IS NOT NULL AND d.`contact_email` <> '')
     OR (d.`contact_phone` IS NOT NULL AND d.`contact_phone` <> '')
   );
--> statement-breakpoint
UPDATE `deals` d
  JOIN `contacts` c
    ON c.`account_id` = d.`account_id`
   AND (c.`business_id` <=> d.`business_id`)
   AND (c.`email` <=> d.`contact_email`)
   AND (c.`phone` <=> d.`contact_phone`)
   SET d.`contact_id` = c.`id`
 WHERE d.`contact_id` IS NULL
   AND (
     (d.`contact_email` IS NOT NULL AND d.`contact_email` <> '')
     OR (d.`contact_phone` IS NOT NULL AND d.`contact_phone` <> '')
   );
