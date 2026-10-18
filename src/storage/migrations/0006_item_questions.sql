CREATE TABLE `item_questions` (
	`message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`item_id` text NOT NULL,
	`created_at` integer NOT NULL
);
