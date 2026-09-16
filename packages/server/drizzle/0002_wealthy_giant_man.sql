ALTER TABLE "players" ALTER COLUMN "gear" SET DEFAULT '{"blaster":"mk1","skin":"default","sprint":false}'::jsonb;--> statement-breakpoint
UPDATE "players" SET "gear" = "gear" || '{"sprint":false}'::jsonb WHERE NOT ("gear" ? 'sprint');
