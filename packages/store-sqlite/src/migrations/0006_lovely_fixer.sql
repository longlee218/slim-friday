CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`wake_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`approval` text,
	`question` text,
	`status` text NOT NULL,
	`answer` text,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	`reminded_at` integer
);
--> statement-breakpoint
CREATE INDEX `cards_status_idx` ON `cards` (`status`);--> statement-breakpoint
CREATE INDEX `cards_scope_idx` ON `cards` (`scope_key`,`status`);--> statement-breakpoint
CREATE TABLE `effect_calls` (
	`key` text PRIMARY KEY NOT NULL,
	`wake_id` text NOT NULL,
	`tool` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `scopes` (
	`key` text PRIMARY KEY NOT NULL,
	`effort` text,
	`reset_pending` integer DEFAULT 0 NOT NULL,
	`last_finished_at` integer,
	`last_flushed_at` integer
);
--> statement-breakpoint
CREATE TABLE `steering` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL,
	`conversation_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`wake_id` text,
	`text` text NOT NULL,
	`attachments` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer
);
--> statement-breakpoint
CREATE INDEX `steering_wake_idx` ON `steering` (`wake_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `steering_scope_idx` ON `steering` (`scope_key`);--> statement-breakpoint
ALTER TABLE `messages` ADD `client_nonce` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_nonce_uq` ON `messages` (`conversation_id`,`client_nonce`);