ALTER TABLE `grants` ADD `effect` text DEFAULT 'always_allow' NOT NULL;--> statement-breakpoint
ALTER TABLE `grants` ADD `match_kind` text DEFAULT 'tool' NOT NULL;