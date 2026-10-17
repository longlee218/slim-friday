CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace` text NOT NULL,
	`channel` text DEFAULT '' NOT NULL,
	`goal_id` text,
	`task_id` text,
	`thread_id` text,
	`title` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`location` text,
	`producer_role` text,
	`version` integer DEFAULT 1 NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_name` ON `artifacts` (`workspace`,`channel`,`name`);--> statement-breakpoint
CREATE INDEX `artifacts_goal` ON `artifacts` (`goal_id`);