CREATE TABLE `teammates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`channel_id` text NOT NULL,
	`preset` text NOT NULL,
	`model` text NOT NULL,
	`tools` text NOT NULL,
	`skills` text NOT NULL,
	`budget_usd` real,
	`max_turns` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teammates_name_unique` ON `teammates` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `teammates_channel_id_unique` ON `teammates` (`channel_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `config_mark` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `teammate_id` text;--> statement-breakpoint
CREATE INDEX `idx_turns_teammate` ON `turns` (`teammate_id`,`started_at`);