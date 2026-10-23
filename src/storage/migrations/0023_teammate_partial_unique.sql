DROP INDEX `teammates_name_unique`;--> statement-breakpoint
DROP INDEX `teammates_channel_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `teammates_name_active` ON `teammates` (`name`) WHERE "teammates"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `teammates_channel_active` ON `teammates` (`channel_id`) WHERE "teammates"."archived_at" IS NULL;