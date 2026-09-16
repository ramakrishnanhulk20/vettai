CREATE TABLE "challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "challenges_kind" CHECK ("challenges"."kind" in ('login', 'claim', 'shop'))
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"quest_id" uuid,
	"kind" text NOT NULL,
	"amount_luna" bigint NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"memo" text NOT NULL,
	"tx_hash" text,
	"block_number" integer,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "claims_tx_hash_unique" UNIQUE("tx_hash"),
	CONSTRAINT "claims_kind" CHECK ("claims"."kind" in ('hunt', 'courier', 'landmarks', 'landlord', 'streak', 'ladder')),
	CONSTRAINT "claims_state" CHECK ("claims"."state" in ('queued', 'sending', 'sent', 'paid', 'failed', 'held')),
	CONSTRAINT "claims_amount_luna" CHECK ("claims"."amount_luna" > 0),
	CONSTRAINT "claims_memo_len" CHECK (octet_length("claims"."memo") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "ladder_periods" (
	"period" text PRIMARY KEY NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_ids" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"address" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ip_hash" text,
	"gear" jsonb DEFAULT '{"blaster":"mk1","skin":"default"}'::jsonb NOT NULL,
	"landlord_since" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"target" integer NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"reward_luna" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "quests_one_per_player_per_day" UNIQUE("address","day","kind"),
	CONSTRAINT "quests_kind" CHECK ("quests"."kind" in ('hunt', 'courier', 'landmarks', 'landlord', 'streak')),
	CONSTRAINT "quests_state" CHECK ("quests"."state" in ('open', 'done', 'claimed')),
	CONSTRAINT "quests_target" CHECK ("quests"."target" > 0),
	CONSTRAINT "quests_progress" CHECK ("quests"."progress" >= 0),
	CONSTRAINT "quests_reward_luna" CHECK ("quests"."reward_luna" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"item" text NOT NULL,
	"price_luna" bigint NOT NULL,
	"memo" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "shop_orders_memo_unique" UNIQUE("memo"),
	CONSTRAINT "shop_orders_tx_hash_unique" UNIQUE("tx_hash"),
	CONSTRAINT "shop_orders_state" CHECK ("shop_orders"."state" in ('pending', 'paid', 'expired')),
	CONSTRAINT "shop_orders_price_luna" CHECK ("shop_orders"."price_luna" > 0),
	CONSTRAINT "shop_orders_memo_len" CHECK (octet_length("shop_orders"."memo") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "stats_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"players" integer DEFAULT 0 NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"paid_luna" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "stats_daily_players" CHECK ("stats_daily"."players" >= 0),
	CONSTRAINT "stats_daily_kills" CHECK ("stats_daily"."kills" >= 0),
	CONSTRAINT "stats_daily_paid_luna" CHECK ("stats_daily"."paid_luna" >= 0)
);
--> statement-breakpoint
CREATE TABLE "watch_cursor" (
	"address" text PRIMARY KEY NOT NULL,
	"last_tx_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_address_players_address_fk" FOREIGN KEY ("address") REFERENCES "public"."players"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_quest_id_quests_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quests" ADD CONSTRAINT "quests_address_players_address_fk" FOREIGN KEY ("address") REFERENCES "public"."players"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_address_players_address_fk" FOREIGN KEY ("address") REFERENCES "public"."players"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_address_players_address_fk" FOREIGN KEY ("address") REFERENCES "public"."players"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claims_one_per_quest" ON "claims" USING btree ("quest_id") WHERE quest_id is not null;--> statement-breakpoint
CREATE INDEX "claims_state_created_idx" ON "claims" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "claims_address_created_idx" ON "claims" USING btree ("address","created_at");--> statement-breakpoint
CREATE INDEX "quests_address_day_idx" ON "quests" USING btree ("address","day");--> statement-breakpoint
CREATE INDEX "sessions_address_idx" ON "sessions" USING btree ("address");--> statement-breakpoint
CREATE INDEX "shop_orders_address_idx" ON "shop_orders" USING btree ("address");