ALTER TABLE `chat_sessions` ADD `title_origin` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `title_summary_status` text DEFAULT 'idle' NOT NULL;