-- Tickets created before they carried a group: take the group of the creator bot's group-conversation run that covered created_at (none if runs in several groups covered it), else the group of the ticket's own group conversation.
UPDATE `tickets` SET `group_id` = CASE
  WHEN `created_by_kind` = 'bot' AND (SELECT count(*) FROM `wakes` w JOIN `conversations` c ON c.`id` = w.`conversation_id` WHERE c.`kind` = 'group' AND w.`target_bot` = `tickets`.`created_by_bot_id` AND w.`started_at` <= `tickets`.`created_at` AND coalesce(w.`ended_at`, 9e18) >= `tickets`.`created_at`) > 0
  THEN (SELECT CASE WHEN count(DISTINCT c.`group_id`) = 1 THEN max(c.`group_id`) END FROM `wakes` w JOIN `conversations` c ON c.`id` = w.`conversation_id` WHERE c.`kind` = 'group' AND w.`target_bot` = `tickets`.`created_by_bot_id` AND w.`started_at` <= `tickets`.`created_at` AND coalesce(w.`ended_at`, 9e18) >= `tickets`.`created_at`)
  ELSE (SELECT c.`group_id` FROM `conversations` c WHERE c.`id` = `tickets`.`conversation_id` AND c.`kind` = 'group')
END WHERE `group_id` IS NULL;
