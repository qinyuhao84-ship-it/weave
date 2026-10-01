CREATE TABLE `chat_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`status` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_artifacts_message` ON `chat_artifacts` (`message_id`);--> statement-breakpoint
ALTER TABLE `chat_runs` ADD `config_json` text;--> statement-breakpoint
ALTER TABLE `chat_runs` ADD `timings_json` text;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `config_json` text;