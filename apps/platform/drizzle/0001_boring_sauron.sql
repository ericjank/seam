-- Apply before starting application workers. Historical timestamp ties have no recoverable insertion order.
ALTER TABLE `acceptance_runs` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `agents` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `agents` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `approvals` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `artifact_versions` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `artifacts` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `artifacts` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `collaborations` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `collaborations` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `connector_jobs` MODIFY COLUMN `available_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `connector_jobs` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `connector_jobs` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `credentials` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `credentials` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `messages` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `organizations` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `organizations` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `participants` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `projects` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `projects` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `proposals` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `proposals` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `sessions` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `work_items` MODIFY COLUMN `created_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `work_items` MODIFY COLUMN `updated_at` timestamp(3) NOT NULL DEFAULT (now(3));--> statement-breakpoint
ALTER TABLE `acceptance_runs` ADD `sequence` int NULL;
--> statement-breakpoint
UPDATE /*+ NO_MERGE(ranked) */ `acceptance_runs` AS target
JOIN (
  SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) AS row_sequence
  FROM `acceptance_runs`
) AS ranked ON target.`id` = ranked.`id`
SET target.`sequence` = ranked.row_sequence;
--> statement-breakpoint
ALTER TABLE `acceptance_runs` MODIFY COLUMN `sequence` int AUTO_INCREMENT NOT NULL, ADD CONSTRAINT `acceptance_runs_sequence_unique` UNIQUE(`sequence`);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `sequence` int NULL;
--> statement-breakpoint
UPDATE /*+ NO_MERGE(ranked) */ `audit_events` AS target
JOIN (
  SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) AS row_sequence
  FROM `audit_events`
) AS ranked ON target.`id` = ranked.`id`
SET target.`sequence` = ranked.row_sequence;
--> statement-breakpoint
ALTER TABLE `audit_events` MODIFY COLUMN `sequence` int AUTO_INCREMENT NOT NULL, ADD CONSTRAINT `audit_events_sequence_unique` UNIQUE(`sequence`);
--> statement-breakpoint
ALTER TABLE `connector_jobs` ADD `sequence` int NULL;
--> statement-breakpoint
UPDATE /*+ NO_MERGE(ranked) */ `connector_jobs` AS target
JOIN (
  SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) AS row_sequence
  FROM `connector_jobs`
) AS ranked ON target.`id` = ranked.`id`
SET target.`sequence` = ranked.row_sequence;
--> statement-breakpoint
ALTER TABLE `connector_jobs` MODIFY COLUMN `sequence` int AUTO_INCREMENT NOT NULL, ADD CONSTRAINT `connector_jobs_sequence_unique` UNIQUE(`sequence`);
--> statement-breakpoint
ALTER TABLE `messages` ADD `sequence` int NULL;
--> statement-breakpoint
UPDATE /*+ NO_MERGE(ranked) */ `messages` AS target
JOIN (
  SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) AS row_sequence
  FROM `messages`
) AS ranked ON target.`id` = ranked.`id`
SET target.`sequence` = ranked.row_sequence;
--> statement-breakpoint
ALTER TABLE `messages` MODIFY COLUMN `sequence` int AUTO_INCREMENT NOT NULL, ADD CONSTRAINT `messages_sequence_unique` UNIQUE(`sequence`);
