-- The role `lead` is renamed: the role id becomes `chief-of-staff`, the engine-level values (structure owner, event `by`,
-- message author, decision event kind) become `teammate`. Engine sessions are dropped: the system prompt changed, so each
-- channel starts one fresh session (memory, episodes and journal stay).
UPDATE `turns` SET `role` = 'chief-of-staff' WHERE `role` = 'lead';
--> statement-breakpoint
UPDATE `owned_tasks` SET `owner_role` = 'chief-of-staff' WHERE `owner_role` = 'lead';
--> statement-breakpoint
UPDATE `owned_tasks` SET `structure_owner` = 'teammate' WHERE `structure_owner` = 'lead';
--> statement-breakpoint
UPDATE `memory_audit` SET `role` = 'chief-of-staff' WHERE `role` = 'lead';
--> statement-breakpoint
UPDATE `artifacts` SET `producer_role` = 'chief-of-staff' WHERE `producer_role` = 'lead';
--> statement-breakpoint
UPDATE `task_messages` SET `author` = 'teammate' WHERE `author` = 'lead';
--> statement-breakpoint
UPDATE `thread_events` SET `kind` = 'teammate_decision' WHERE `kind` = 'lead_decision';
--> statement-breakpoint
UPDATE `thread_events` SET `payload` = json_set(`payload`, '$.by', 'teammate') WHERE json_valid(`payload`) AND json_extract(`payload`, '$.by') = 'lead';
--> statement-breakpoint
DELETE FROM `sessions` WHERE `kind` = 'lead';
