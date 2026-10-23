CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`template_version` integer NOT NULL,
	`count` integer NOT NULL,
	`seed` text NOT NULL,
	`status` text NOT NULL,
	`rerun_of` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `batches_created_at` ON `batches` (`created_at`);--> statement-breakpoint
CREATE TABLE `fixtures` (
	`batch_id` text NOT NULL,
	`fixture_index` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`attempts` integer NOT NULL,
	`page_count` integer,
	`data_sha256` text,
	`gt_sha256` text,
	`pdf_sha256` text,
	PRIMARY KEY(`batch_id`, `fixture_index`),
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade
);
