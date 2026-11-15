ALTER TABLE `collaboration_lifecycles` ADD `protocol_version` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `collaboration_lifecycles` ADD `shared_facts` json;--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD `attempt_history` json;