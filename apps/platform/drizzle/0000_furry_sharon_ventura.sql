CREATE TABLE IF NOT EXISTS `acceptance_runs` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`work_item_id` varchar(36),
	`participant_id` varchar(36) NOT NULL,
	`artifact_version_id` varchar(36),
	`status` enum('passed','failed') NOT NULL,
	`summary` text NOT NULL,
	`evidence` json NOT NULL DEFAULT ('{}'),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `acceptance_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agents` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`adapter` enum('claude-code','codex','generic-cli','mock') NOT NULL,
	`status` enum('offline','online','busy','error') NOT NULL DEFAULT 'offline',
	`token_hash` varchar(64) NOT NULL,
	`last_seen_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `agents_id` PRIMARY KEY(`id`),
	CONSTRAINT `agents_project_name_unique` UNIQUE(`project_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `approvals` (
	`id` varchar(36) NOT NULL,
	`proposal_id` varchar(36) NOT NULL,
	`participant_id` varchar(36) NOT NULL,
	`artifact_version_id` varchar(36),
	`decision` enum('approved','rejected') NOT NULL,
	`comment` text NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `approvals_id` PRIMARY KEY(`id`),
	CONSTRAINT `approvals_proposal_participant_unique` UNIQUE(`proposal_id`,`participant_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `artifact_versions` (
	`id` varchar(36) NOT NULL,
	`artifact_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`content` text NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`created_by_participant_id` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `artifact_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `artifact_versions_version_unique` UNIQUE(`artifact_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `artifacts` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`title` varchar(200) NOT NULL,
	`type` enum('openapi','asyncapi','json-schema','markdown','test-plan','test-report','custom') NOT NULL,
	`current_version` int NOT NULL DEFAULT 1,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `artifacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_events` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36),
	`actor_type` enum('user','agent','connector','system') NOT NULL,
	`actor_id` varchar(100),
	`action` varchar(100) NOT NULL,
	`metadata` json NOT NULL DEFAULT ('{}'),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `collaborations` (
	`id` varchar(36) NOT NULL,
	`title` varchar(200) NOT NULL,
	`type` enum('api-integration','event-integration','data-contract','release-coordination','custom') NOT NULL,
	`status` enum('draft','negotiating','accepted','in_progress','validating','completed','rejected') NOT NULL DEFAULT 'draft',
	`objective` text NOT NULL,
	`created_by_id` varchar(36) NOT NULL,
	`negotiation_round` int NOT NULL DEFAULT 0,
	`max_negotiation_rounds` int NOT NULL DEFAULT 12,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `collaborations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `connector_jobs` (
	`id` varchar(36) NOT NULL,
	`agent_id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36),
	`kind` enum('collaboration.turn','a2a.message','local.test') NOT NULL,
	`payload` json NOT NULL,
	`status` enum('pending','running','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
	`result` json,
	`error` text,
	`attempts` int NOT NULL DEFAULT 0,
	`available_at` timestamp(3) NOT NULL DEFAULT (now()),
	`lease_until` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `connector_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credentials` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`owner_participant_id` varchar(36) NOT NULL,
	`recipient_participant_id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`type` enum('api-token','test-account','webhook-secret','oauth-client') NOT NULL,
	`environment` varchar(50) NOT NULL DEFAULT 'test',
	`purpose` text NOT NULL,
	`status` enum('requested','offered','approved','granted','revoked','rejected','expired') NOT NULL DEFAULT 'requested',
	`ciphertext` text,
	`encrypted_dek` text,
	`iv` varchar(32),
	`auth_tag` varchar(32),
	`expires_at` timestamp(3),
	`approved_at` timestamp(3),
	`granted_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `credentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dependencies` (
	`id` varchar(36) NOT NULL,
	`work_item_id` varchar(36) NOT NULL,
	`depends_on_id` varchar(36) NOT NULL,
	CONSTRAINT `dependencies_id` PRIMARY KEY(`id`),
	CONSTRAINT `dependencies_unique` UNIQUE(`work_item_id`,`depends_on_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`participant_id` varchar(36),
	`author_type` enum('user','agent','system') NOT NULL,
	`author_name` varchar(200) NOT NULL,
	`kind` enum('chat','question','clarification','objection','status','system') NOT NULL DEFAULT 'chat',
	`body` text NOT NULL,
	`metadata` json NOT NULL DEFAULT ('{}'),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `organizations` (
	`id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `organizations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `participants` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`agent_id` varchar(36),
	`role` enum('coordinator','provider','consumer','reviewer','participant') NOT NULL DEFAULT 'participant',
	`approval_required` boolean NOT NULL DEFAULT true,
	`status` enum('invited','active','declined') NOT NULL DEFAULT 'invited',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `participants_id` PRIMARY KEY(`id`),
	CONSTRAINT `participants_collab_project_unique` UNIQUE(`collaboration_id`,`project_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `projects` (
	`id` varchar(36) NOT NULL,
	`org_id` varchar(36) NOT NULL,
	`name` varchar(200) NOT NULL,
	`slug` varchar(80) NOT NULL,
	`description` text NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_org_slug_unique` UNIQUE(`org_id`,`slug`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `proposals` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`artifact_version_id` varchar(36),
	`title` varchar(200) NOT NULL,
	`body` text NOT NULL,
	`status` enum('open','accepted','rejected','superseded') NOT NULL DEFAULT 'open',
	`approval_mode` enum('all','required') NOT NULL DEFAULT 'required',
	`created_by_participant_id` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `proposals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`token_hash` varchar(64) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `sessions_token_hash` PRIMARY KEY(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` varchar(36) NOT NULL,
	`org_id` varchar(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`email` varchar(320) NOT NULL,
	`password_hash` text NOT NULL,
	`role` enum('owner','member','viewer') NOT NULL DEFAULT 'member',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_items` (
	`id` varchar(36) NOT NULL,
	`collaboration_id` varchar(36) NOT NULL,
	`proposal_id` varchar(36),
	`assignee_participant_id` varchar(36),
	`title` varchar(200) NOT NULL,
	`description` text NOT NULL,
	`status` enum('pending','in_progress','blocked','validating','completed','rejected') NOT NULL DEFAULT 'pending',
	`priority` enum('low','normal','high','critical') NOT NULL DEFAULT 'normal',
	`acceptance_criteria` text NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `work_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `acceptance_runs` ADD CONSTRAINT `acceptance_runs_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `acceptance_runs` ADD CONSTRAINT `acceptance_runs_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `acceptance_runs` ADD CONSTRAINT `acceptance_runs_participant_id_participants_id_fk` FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `acceptance_runs` ADD CONSTRAINT `acceptance_runs_artifact_version_id_artifact_versions_id_fk` FOREIGN KEY (`artifact_version_id`) REFERENCES `artifact_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agents` ADD CONSTRAINT `agents_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_proposal_id_proposals_id_fk` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_participant_id_participants_id_fk` FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_artifact_version_id_artifact_versions_id_fk` FOREIGN KEY (`artifact_version_id`) REFERENCES `artifact_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifact_versions` ADD CONSTRAINT `artifact_versions_artifact_id_artifacts_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifact_versions` ADD CONSTRAINT `artifact_versions_created_by_participant_id_participants_id_fk` FOREIGN KEY (`created_by_participant_id`) REFERENCES `participants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifacts` ADD CONSTRAINT `artifacts_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_events` ADD CONSTRAINT `audit_events_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collaborations` ADD CONSTRAINT `collaborations_created_by_id_users_id_fk` FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_jobs` ADD CONSTRAINT `connector_jobs_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `connector_jobs` ADD CONSTRAINT `connector_jobs_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credentials` ADD CONSTRAINT `credentials_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credentials` ADD CONSTRAINT `credentials_owner_participant_id_participants_id_fk` FOREIGN KEY (`owner_participant_id`) REFERENCES `participants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credentials` ADD CONSTRAINT `credentials_recipient_participant_id_participants_id_fk` FOREIGN KEY (`recipient_participant_id`) REFERENCES `participants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dependencies` ADD CONSTRAINT `dependencies_work_item_id_work_items_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dependencies` ADD CONSTRAINT `dependencies_depends_on_id_work_items_id_fk` FOREIGN KEY (`depends_on_id`) REFERENCES `work_items`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_participant_id_participants_id_fk` FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participants` ADD CONSTRAINT `participants_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participants` ADD CONSTRAINT `participants_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participants` ADD CONSTRAINT `participants_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_artifact_version_id_artifact_versions_id_fk` FOREIGN KEY (`artifact_version_id`) REFERENCES `artifact_versions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `proposals` ADD CONSTRAINT `proposals_created_by_participant_id_participants_id_fk` FOREIGN KEY (`created_by_participant_id`) REFERENCES `participants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_items` ADD CONSTRAINT `work_items_collaboration_id_collaborations_id_fk` FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_items` ADD CONSTRAINT `work_items_proposal_id_proposals_id_fk` FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_items` ADD CONSTRAINT `work_items_assignee_participant_id_participants_id_fk` FOREIGN KEY (`assignee_participant_id`) REFERENCES `participants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_collab_created_idx` ON `audit_events` (`collaboration_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `connector_jobs_agent_status_idx` ON `connector_jobs` (`agent_id`,`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `messages_collab_created_idx` ON `messages` (`collaboration_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `participants_collab_idx` ON `participants` (`collaboration_id`);