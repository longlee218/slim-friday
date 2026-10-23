CREATE TABLE `peer_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_key` text NOT NULL,
	`from_teammate` text,
	`to_teammate` text NOT NULL,
	`intent` text NOT NULL,
	`text` text NOT NULL,
	`text_hash` text NOT NULL,
	`reply_to` integer,
	`hop` integer NOT NULL,
	`source_thread` text NOT NULL,
	`target_thread` text NOT NULL,
	`echo_posted_at` integer,
	`inbound_posted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peer_messages_delivery_key_unique` ON `peer_messages` (`delivery_key`);--> statement-breakpoint
CREATE INDEX `peer_messages_from_idx` ON `peer_messages` (`from_teammate`,`created_at`);--> statement-breakpoint
CREATE INDEX `peer_messages_target_idx` ON `peer_messages` (`target_thread`,`created_at`);