CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`citations_json` text,
	`context_json` text,
	`filed_as_page_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_session` ON `chat_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '新对话' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_page_id` text NOT NULL,
	`target_page_id` text NOT NULL,
	`rel_type` text DEFAULT 'mentions' NOT NULL,
	`weight` real DEFAULT 0.5 NOT NULL,
	`signals_json` text,
	`evidence_page_path` text,
	`source_doc_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_edges_source` ON `edges` (`source_page_id`);--> statement-breakpoint
CREATE INDEX `idx_edges_target` ON `edges` (`target_page_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_edges_unique` ON `edges` (`source_page_id`,`target_page_id`,`rel_type`);--> statement-breakpoint
CREATE TABLE `index_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'uploaded' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 100 NOT NULL,
	`message` text,
	`error` text,
	`payload_json` text,
	`draft_json` text,
	`result_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_jobs_kind` ON `jobs` (`kind`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`src_page_id` text NOT NULL,
	`dst_raw` text NOT NULL,
	`dst_normalized` text NOT NULL,
	`dst_page_id` text,
	`heading` text,
	`alias` text,
	`occurrences` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_links_src` ON `links` (`src_page_id`);--> statement-breakpoint
CREATE INDEX `idx_links_dst` ON `links` (`dst_page_id`);--> statement-breakpoint
CREATE INDEX `idx_links_dst_normalized` ON `links` (`dst_normalized`);--> statement-breakpoint
CREATE INDEX `idx_links_dangling` ON `links` (`dst_normalized`,`dst_page_id`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`file_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`frontmatter_json` text NOT NULL,
	`normalized_names` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`deleted_at` text,
	`redirect_to` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pages_file_path` ON `pages` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_pages_slug` ON `pages` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_pages_type` ON `pages` (`type`);--> statement-breakpoint
CREATE INDEX `idx_pages_status` ON `pages` (`status`);--> statement-breakpoint
CREATE TABLE `redirects` (
	`old_normalized` text PRIMARY KEY NOT NULL,
	`old_raw` text NOT NULL,
	`new_page_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_redirects_new` ON `redirects` (`new_page_id`);--> statement-breakpoint
CREATE TABLE `review_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`severity` text DEFAULT 'info' NOT NULL,
	`related_page_ids` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`suggested_action` text,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_review_status` ON `review_items` (`status`,`kind`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_path` text NOT NULL,
	`original_name` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`mime_type` text,
	`title` text,
	`imported_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`parsed_path` text,
	`page_count` integer,
	`parser` text,
	`meta_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sources_sha256` ON `sources` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_sources_status` ON `sources` (`status`);