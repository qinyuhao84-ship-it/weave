CREATE TABLE `ingest_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`original_name` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`job_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ingest_queue_status_created` ON `ingest_queue` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ingest_queue_job` ON `ingest_queue` (`job_id`);