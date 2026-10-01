ALTER TABLE `chat_sessions` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `idx_chat_sessions_deleted` ON `chat_sessions` (`deleted_at`);