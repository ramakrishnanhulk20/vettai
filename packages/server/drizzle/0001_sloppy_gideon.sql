ALTER TABLE "watch_cursor" ADD COLUMN "last_block_number" bigint;--> statement-breakpoint
ALTER TABLE "watch_cursor" DROP COLUMN "last_tx_hash";