ALTER TABLE `cards` ADD `answered_message_id` integer;--> statement-breakpoint
CREATE INDEX `cards_answered_message_idx` ON `cards` (`answered_message_id`);