-- Room for the providers whose read APIs were actually verified, so adding one later
-- is code rather than a schema change made under time pressure.
--
-- Only providers confirmed to expose a merchant-readable transaction list are here.
-- PayFast and Ozow are deliberately absent: both are push-only, so their money arrives
-- through the ITN/notify path and becomes a payment against an invoice, not a synced
-- sale. SnapScan is included because it can be read, even though it reports no fee.
ALTER TABLE `payment_connections`
  MODIFY COLUMN `provider` enum('yoco','zapper','snapscan','paystack','peach') NOT NULL;
--> statement-breakpoint
ALTER TABLE `sales`
  MODIFY COLUMN `provider` enum('yoco','zapper','snapscan','paystack','peach','manual') NOT NULL;
