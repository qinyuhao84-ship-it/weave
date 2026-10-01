ALTER TABLE `review_items` RENAME COLUMN `related_page_ids` TO `related_pages`;--> statement-breakpoint
ALTER TABLE `review_items` ADD `decision_note` text;
