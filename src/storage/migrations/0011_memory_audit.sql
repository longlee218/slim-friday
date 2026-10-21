CREATE TABLE `memory_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`thread_id` text NOT NULL,
	`channel` text NOT NULL,
	`role` text NOT NULL,
	`action` text NOT NULL,
	`scope` text NOT NULL,
	`hash` text NOT NULL
);
