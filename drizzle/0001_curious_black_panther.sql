CREATE TABLE `chat_summaries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`covered_to_message_id` text NOT NULL,
	`covered_message_count` integer DEFAULT 0 NOT NULL,
	`compression_count` integer DEFAULT 0 NOT NULL,
	`token_count` integer DEFAULT 0 NOT NULL,
	`model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `prompt_tokens` integer;