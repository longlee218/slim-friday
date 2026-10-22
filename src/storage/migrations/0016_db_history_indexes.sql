CREATE INDEX `thread_events_item` ON `thread_events` (`item_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_tool_calls_turn` ON `tool_calls` (`turn_id`);--> statement-breakpoint
CREATE INDEX `work_plans_goal` ON `work_plans` (`goal_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_turns_task` ON `turns` (`owned_task_id`);--> statement-breakpoint
CREATE INDEX `idx_turns_session` ON `turns` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_turns_role_status` ON `turns` (`role`,`status`);--> statement-breakpoint
CREATE INDEX `idx_turns_ended` ON `turns` (`ended_at`);