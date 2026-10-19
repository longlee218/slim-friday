ALTER TABLE `owned_tasks` ADD `structure_owner` text;--> statement-breakpoint
-- Backfill (goal rows only): a goal with a plan, or with a planner item (any status, plan not written yet), is planner-owned; every other goal lead-owned.
UPDATE `owned_tasks` SET `structure_owner` = CASE WHEN `id` IN (SELECT `goal_id` FROM `work_plans`) OR `id` IN (SELECT `parent_id` FROM `owned_tasks` WHERE `item_key` LIKE 'planner%') THEN 'planner' ELSE 'lead' END WHERE `parent_id` IS NULL;
