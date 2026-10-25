CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`fired_at` integer NOT NULL,
	`manual` integer NOT NULL,
	`late` integer NOT NULL,
	`status` text NOT NULL,
	`wake_id` text,
	`ended_at` integer,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `schedule_runs_schedule_idx` ON `schedule_runs` (`schedule_id`,`fired_at`);--> statement-breakpoint
CREATE INDEX `schedule_runs_status_idx` ON `schedule_runs` (`status`);--> statement-breakpoint
CREATE INDEX `schedule_runs_wake_idx` ON `schedule_runs` (`wake_id`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`bot_id` text NOT NULL,
	`task` text NOT NULL,
	`rule` text NOT NULL,
	`time_zone` text NOT NULL,
	`conversation_id` text NOT NULL,
	`notify` text NOT NULL,
	`enabled` integer NOT NULL,
	`next_run_at` integer,
	`last_fire_at` integer,
	`disabled_reason` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `schedules_due_idx` ON `schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
ALTER TABLE `wakes` ADD `schedule_id` text;--> statement-breakpoint
ALTER TABLE `wakes` ADD `schedule_quiet` integer;