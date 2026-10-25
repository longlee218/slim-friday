CREATE TABLE `mcp_oauth` (
	`server` text PRIMARY KEY NOT NULL,
	`server_url` text NOT NULL,
	`client_id` text NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token` text,
	`access_expires_at` integer,
	`status` text NOT NULL,
	`last_refresh_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
