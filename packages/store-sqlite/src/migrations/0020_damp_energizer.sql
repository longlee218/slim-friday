CREATE TABLE `computer_holds` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`computer` text NOT NULL,
	`bot_id` text NOT NULL,
	`holder` text NOT NULL,
	`fence` integer NOT NULL,
	`expires_at` integer NOT NULL
);
