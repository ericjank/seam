CREATE TABLE `workflow_wakeups` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`source_job_id` varchar(36),
	`snapshot` json,
	`attempts` int NOT NULL DEFAULT 0,
	`available_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	`completed_at` timestamp(3),
	`error` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	CONSTRAINT `workflow_wakeups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `collaboration_lifecycles` MODIFY COLUMN `phase` enum('planning','plan_synthesis','plan_confirmation','awaiting_approval','executing','joint_verifying','awaiting_review','terminated') NOT NULL DEFAULT 'planning';--> statement-breakpoint
ALTER TABLE `collaboration_lifecycles` ADD `paused_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `connector_jobs` ADD `receipt_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `connector_jobs` ADD `cancellation_ack_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `lifecycle_contributions` ADD `workspace_baseline` json;--> statement-breakpoint
ALTER TABLE `lifecycle_contributions` ADD `integration_checks` json;--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD `change_request` longtext;--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD `shared_contract` json;--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD `objections` json;--> statement-breakpoint
ALTER TABLE `workflow_wakeups` ADD CONSTRAINT `workflow_wakeups_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `workflow_wakeups_pending_idx` ON `workflow_wakeups` (`completed_at`,`available_at`);