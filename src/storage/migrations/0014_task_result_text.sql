ALTER TABLE `owned_tasks` ADD `result_text` text;
--> statement-breakpoint
UPDATE `artifacts` SET `summary` = 1 WHERE `origin` = 'store' AND `producer_role` IS NULL AND `task_id` IS NULL AND `title` GLOB 'Plan ???????? v[0-9]*';
