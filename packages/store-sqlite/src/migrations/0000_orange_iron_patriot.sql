CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`bot_id` text NOT NULL,
	`tool` text NOT NULL,
	`outcome` text NOT NULL,
	`answer` text,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`bot_id` text,
	`group_id` text
);
--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`tool` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `grants_bot_idx` ON `grants` (`bot_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_bot_id` text,
	`text` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spend` (
	`bot_id` text NOT NULL,
	`day` text NOT NULL,
	`usd` real NOT NULL,
	PRIMARY KEY(`bot_id`, `day`)
);
