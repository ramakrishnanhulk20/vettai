CREATE TABLE "received_payments" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"value_luna" bigint NOT NULL,
	"memo" text,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"order_id" uuid,
	"outcome" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "received_payments_outcome" CHECK ("received_payments"."outcome" in ('paid', 'short', 'expired', 'unknown_memo', 'sender_mismatch', 'already_paid')),
	CONSTRAINT "received_payments_value_luna" CHECK ("received_payments"."value_luna" >= 0)
);
--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "held_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quests" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD COLUMN "block_number" bigint;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD COLUMN "announced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "received_payments_order_idx" ON "received_payments" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_attempts" CHECK ("claims"."attempts" >= 0);