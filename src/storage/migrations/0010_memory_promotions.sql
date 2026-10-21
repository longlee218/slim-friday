CREATE TABLE `memory_promotions` (
	`workspace` text NOT NULL,
	`channel` text NOT NULL,
	`hash` text NOT NULL,
	`promoted_at` integer NOT NULL,
	PRIMARY KEY(`workspace`, `channel`, `hash`)
);
