CREATE TABLE `conversation_reads` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`conversation_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`source` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`actor_kind` text NOT NULL,
	`actor_bot_id` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_idx` ON `ticket_events` (`ticket_id`,`at`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`conversation_id` text,
	`purpose` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`state` text NOT NULL,
	`message_id` integer,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `uploads_state_idx` ON `uploads` (`state`,`at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `kind` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `files` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `run` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `relay` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `conversation_id` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `blocked_reason` text;