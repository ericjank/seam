CREATE TABLE `readiness_probes` (
	`id` varchar(50) NOT NULL,
	`nonce` varchar(36) NOT NULL,
	`checked_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	CONSTRAINT `readiness_probes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD `retry_budget` json;