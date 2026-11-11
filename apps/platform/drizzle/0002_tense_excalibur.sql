CREATE TABLE `collaboration_lifecycles` (
	`collaboration_id` varchar(36) NOT NULL,
	`revision` int NOT NULL DEFAULT 1,
	`phase` enum('planning','plan_confirmation','awaiting_approval','executing','awaiting_review','terminated') NOT NULL DEFAULT 'planning',
	`required_participant_ids` json NOT NULL,
	`document_hash` varchar(64),
	`approved_hash` varchar(64),
	`approved_by_id` varchar(36),
	`approved_at` timestamp(3),
	`terminated_by_id` varchar(36),
	`terminated_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	CONSTRAINT `collaboration_lifecycles_collaboration_id` PRIMARY KEY(`collaboration_id`)
);
--> statement-breakpoint
CREATE TABLE `lifecycle_contributions` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`revision` int NOT NULL,
	`participant_id` varchar(36) NOT NULL,
	`content` longtext,
	`confirmed_hash` varchar(64),
	`report_status` enum('passed','failed'),
	`report_summary` longtext,
	`report_evidence` json,
	`created_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	CONSTRAINT `lifecycle_contributions_id` PRIMARY KEY(`id`),
	CONSTRAINT `lifecycle_contributions_collab_revision_participant_unique` UNIQUE(`collaboration_id`,`revision`,`participant_id`)
);
--> statement-breakpoint
CREATE TABLE `lifecycle_revisions` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`revision` int NOT NULL,
	`requirements` longtext NOT NULL,
	`document` longtext,
	`document_hash` varchar(64),
	`report` longtext,
	`created_by_id` varchar(36) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now(3)),
	CONSTRAINT `lifecycle_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `lifecycle_revisions_collab_revision_unique` UNIQUE(`collaboration_id`,`revision`)
);
--> statement-breakpoint
ALTER TABLE `agents` MODIFY COLUMN `adapter` enum('claude-code','codex','codex-app-server','generic-cli','mock') NOT NULL;--> statement-breakpoint
ALTER TABLE `collaboration_lifecycles` ADD CONSTRAINT `collaboration_lifecycles_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collaboration_lifecycles` ADD CONSTRAINT `collaboration_lifecycles_approved_by_id_users_id_fk` FOREIGN KEY (`approved_by_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collaboration_lifecycles` ADD CONSTRAINT `collaboration_lifecycles_terminated_by_id_users_id_fk` FOREIGN KEY (`terminated_by_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_contributions` ADD CONSTRAINT `lifecycle_contributions_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_contributions` ADD CONSTRAINT `lifecycle_contributions_participant_id_participants_id_fk` FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD CONSTRAINT `lifecycle_revisions_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD CONSTRAINT `lifecycle_revisions_created_by_id_users_id_fk` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;