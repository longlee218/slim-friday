CREATE TABLE `scratchpad` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`bot_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scratchpad_scope_idx` ON `scratchpad` (`scope_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `scratchpad_status_idx` ON `scratchpad` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `wake_id` text;--> statement-breakpoint
CREATE INDEX `messages_wake_idx` ON `messages` (`wake_id`);--> statement-breakpoint
ALTER TABLE `wakes` ADD `intro` integer;--> statement-breakpoint
ALTER TABLE `wakes` ADD `nudges` integer DEFAULT 0 NOT NULL;