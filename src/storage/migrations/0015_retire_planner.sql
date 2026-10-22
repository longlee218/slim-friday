-- The planner role is gone: the lead writes the plan. A PLAN goal's structure owner `planner` becomes `plan`; open planner items
-- (they would need a role that no longer exists) are cancelled. Rows of finished planner items stay readable.
UPDATE `owned_tasks` SET `structure_owner` = 'plan' WHERE `structure_owner` = 'planner';
--> statement-breakpoint
UPDATE `owned_tasks` SET `status` = 'cancelled' WHERE `owner_role` = 'planner' AND `status` IN ('pending', 'ready', 'running', 'waiting_user', 'blocked');
