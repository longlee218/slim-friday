CREATE TABLE `task_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`task_id` text NOT NULL,
	`author` text NOT NULL,
	`kind` text NOT NULL,
	`reply_to` integer,
	`text` text NOT NULL,
	`files` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_messages_task` ON `task_messages` (`task_id`,`id`);--> statement-breakpoint
CREATE INDEX `task_messages_thread` ON `task_messages` (`thread_id`,`id`);--> statement-breakpoint
ALTER TABLE `work_plans` ADD `spec_md` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_plans` ADD `plan_md` text DEFAULT '' NOT NULL;