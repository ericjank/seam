ALTER TABLE `lifecycle_contributions` ADD `fact_refs` json;--> statement-breakpoint
ALTER TABLE `lifecycle_contributions` ADD `pending_plan` json;--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD `fact_bindings` json;--> statement-breakpoint
ALTER TABLE `lifecycle_revisions` ADD `approval_intent` json;