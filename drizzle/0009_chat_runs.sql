CREATE TABLE `chat_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`question_message_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_chat_runs_session_status` ON `chat_runs` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_chat_runs_status` ON `chat_runs` (`status`);