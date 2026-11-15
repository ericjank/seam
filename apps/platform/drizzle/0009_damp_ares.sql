ALTER TABLE `collaboration_lifecycles` ADD `final_decision` json;--> statement-breakpoint
ALTER TABLE `connector_jobs` ADD `recovery_key_hash` varchar(64);