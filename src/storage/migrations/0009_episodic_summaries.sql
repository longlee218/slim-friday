ALTER TABLE `thread_summaries` ADD `channel` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_summaries` ADD `key_topics` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_summaries` ADD `abstract` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_summaries` ADD `promoted_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_summaries` DROP COLUMN `rolled_at`;