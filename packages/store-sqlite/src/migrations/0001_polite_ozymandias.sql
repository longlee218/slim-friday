CREATE TABLE `wakes` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_id` text NOT NULL,
	`parent_wake_id` text,
	`conversation_id` text NOT NULL,
	`target_bot` text NOT NULL,
	`sender_kind` text NOT NULL,
	`sender_bot_id` text,
	`intent` text NOT NULL,
	`hop` integer NOT NULL,
	`text` text NOT NULL,
	`attachments` text,
	`handoff` integer,
	`status` text NOT NULL,
	`block_reason` text,
	`attempts` integer NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`first_text_at` integer,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `wakes_status_idx` ON `wakes` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `wakes_conversation_idx` ON `wakes` (`conversation_id`,`created_at`);