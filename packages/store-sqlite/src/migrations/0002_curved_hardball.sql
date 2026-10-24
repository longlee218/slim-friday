CREATE TABLE `ticket_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_bot_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ticket_comments_ticket_idx` ON `ticket_comments` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ticket_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`last` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`assignee_bot_id` text,
	`created_by_kind` text NOT NULL,
	`created_by_bot_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_number_unique` ON `tickets` (`number`);--> statement-breakpoint
CREATE INDEX `tickets_created_idx` ON `tickets` (`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `wakes` ADD `ticket_id` text;--> statement-breakpoint
ALTER TABLE `wakes` ADD `rewake` integer;