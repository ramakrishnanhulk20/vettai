ALTER TABLE "claims" DROP CONSTRAINT "claims_state";--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "validity_start_height" bigint;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_orders_one_pending_per_item" ON "shop_orders" USING btree ("address","item") WHERE state = 'pending';--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_state" CHECK ("claims"."state" in ('queued', 'sending', 'sent', 'paid', 'failed', 'held', 'cancelled'));