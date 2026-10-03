DROP INDEX `idx_pages_file_path`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pages_file_path` ON `pages` (`file_path`) WHERE "pages"."status" = 'active';--> statement-breakpoint
ALTER TABLE `chat_summaries` ADD `history_policy` text DEFAULT 'legacy' NOT NULL;