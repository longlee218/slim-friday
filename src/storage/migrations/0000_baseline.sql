CREATE TABLE `effect_log` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`goal_id` text,
	`item_id` text,
	`tool` text NOT NULL,
	`scope` text NOT NULL,
	`granted_by` text NOT NULL,
	`result` text NOT NULL,
	`undo` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`thread_id` text NOT NULL,
	`session_id` text,
	`run_id` text,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`task_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_run_messages_thread` ON `run_messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE TABLE `thread_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`thread_id` text NOT NULL,
	`task_id` text,
	`item_id` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`correlation_id` text,
	`causation_id` text,
	`created_at` integer NOT NULL,
	`claimed_by` text,
	`delivered_at` integer,
	`redelivered` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_events_id_unique` ON `thread_events` (`id`);--> statement-breakpoint
CREATE INDEX `thread_events_pending` ON `thread_events` (`thread_id`,`delivered_at`,`seq`);--> statement-breakpoint
CREATE TABLE `memory_files` (
	`path` text PRIMARY KEY NOT NULL,
	`workspace` text NOT NULL,
	`mtime_ms` integer NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	`compactions` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runs_turn` ON `runs` (`turn_id`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool` text NOT NULL,
	`input_json` text NOT NULL,
	`output_preview` text NOT NULL,
	`is_error` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`agent_id` text,
	`turn_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_tool_calls_run` ON `tool_calls` (`run_id`);--> statement-breakpoint
CREATE TABLE `work_plans` (
	`id` text NOT NULL,
	`version` integer NOT NULL,
	`goal_id` text NOT NULL,
	`status` text NOT NULL,
	`strategy` text NOT NULL,
	`objective` text NOT NULL,
	`body` text NOT NULL,
	`acceptance` text DEFAULT '[]' NOT NULL,
	`envelope` text DEFAULT '{}' NOT NULL,
	`budget_usd` real,
	`effects` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	PRIMARY KEY(`id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`location` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	`model` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`kind` text DEFAULT 'role' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owned_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`owner_role` text,
	`status` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`correlation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_progress_at` integer NOT NULL,
	`parent_id` text,
	`item_key` text,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`dispatch_count` integer DEFAULT 0 NOT NULL,
	`location` text,
	`brief` text,
	`result_kind` text,
	`result_path` text,
	`result_excerpt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owned_tasks_goal_item` ON `owned_tasks` (`parent_id`,`item_key`) WHERE "owned_tasks"."parent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `owned_tasks_parent` ON `owned_tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `owned_tasks_thread_progress` ON `owned_tasks` (`thread_id`,`last_progress_at`);--> statement-breakpoint
CREATE TABLE `thread_summaries` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`workspace` text DEFAULT '' NOT NULL,
	`summary` text NOT NULL,
	`rolled_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`cycle` integer DEFAULT 0 NOT NULL,
	`flushed_cycle` integer DEFAULT -1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`workspace` text DEFAULT '' NOT NULL,
	`origin` text NOT NULL,
	`placeholder` text,
	`title` text,
	`digest` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_channel_updated` ON `threads` (`channel_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`tool` text NOT NULL,
	`summary` text NOT NULL,
	`decision` text NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`source` text NOT NULL,
	`location` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`session_id` text,
	`brief` text,
	`role` text NOT NULL,
	`kind` text DEFAULT 'staged' NOT NULL,
	`parent_turn_id` text,
	`hop` integer DEFAULT 0 NOT NULL,
	`counts_toward_cap` integer DEFAULT 1 NOT NULL,
	`owned_task_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_turns_thread` ON `turns` (`thread_id`);