CREATE TABLE `run_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`wake_id` text NOT NULL,
	`fence` integer NOT NULL,
	`owner` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `run_attempts_wake_idx` ON `run_attempts` (`wake_id`);--> statement-breakpoint
ALTER TABLE `wakes` ADD `scope_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `wakes` ADD `priority` text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE `wakes` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `wakes` ADD `lease_fence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wakes` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `wakes` ADD `wake_at` integer;--> statement-breakpoint
ALTER TABLE `wakes` ADD `card_id` text;--> statement-breakpoint
ALTER TABLE `wakes` ADD `tainted` integer;--> statement-breakpoint
ALTER TABLE `wakes` ADD `result_text` text;--> statement-breakpoint
ALTER TABLE `wakes` ADD `error` text;--> statement-breakpoint
ALTER TABLE `wakes` ADD `outcome_returned_at` integer;--> statement-breakpoint
ALTER TABLE `wakes` ADD `dedupe_key` text;--> statement-breakpoint
ALTER TABLE `wakes` ADD `cuts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wakes` ADD `transient_retries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wakes` ADD `setup_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `wakes_claim_idx` ON `wakes` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `wakes_scope_idx` ON `wakes` (`scope_key`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `wakes_dedupe_idx` ON `wakes` (`conversation_id`,`dedupe_key`);--> statement-breakpoint
UPDATE `wakes` SET `scope_key` = `target_bot`;
