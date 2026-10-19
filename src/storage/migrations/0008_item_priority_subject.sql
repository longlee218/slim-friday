ALTER TABLE `owned_tasks` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `owned_tasks` ADD `subject` text;--> statement-breakpoint
-- Backfill (item rows only): the subject is the first line of the brief, at most 80 chars.
UPDATE `owned_tasks` SET `subject` = substr(replace(replace(`brief`, char(10), ' '), char(13), ' '), 1, 80) WHERE `parent_id` IS NOT NULL AND `brief` IS NOT NULL;
