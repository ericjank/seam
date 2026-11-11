import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const id = () => varchar("id", { length: 36 });
const timestamps = {
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
  updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
};

export const organizations = mysqlTable("organizations", {
  id: id().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  ...timestamps,
});

export const users = mysqlTable("users", {
  id: id().primaryKey(),
  orgId: varchar("org_id", { length: 36 }).notNull().references(() => organizations.id),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  role: mysqlEnum("role", ["owner", "member", "viewer"]).notNull().default("member"),
  ...timestamps,
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const sessions = mysqlTable("sessions", {
  tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
});

export const projects = mysqlTable("projects", {
  id: id().primaryKey(),
  orgId: varchar("org_id", { length: 36 }).notNull().references(() => organizations.id),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull(),
  description: text("description").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("projects_org_slug_unique").on(table.orgId, table.slug)]);

export const agents = mysqlTable("agents", {
  id: id().primaryKey(),
  projectId: varchar("project_id", { length: 36 }).notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  adapter: mysqlEnum("adapter", ["claude-code", "codex", "codex-app-server", "generic-cli", "mock"]).notNull(),
  status: mysqlEnum("status", ["offline", "online", "busy", "error"]).notNull().default("offline"),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { fsp: 3 }),
  ...timestamps,
}, (table) => [uniqueIndex("agents_project_name_unique").on(table.projectId, table.name)]);

export const collaborations = mysqlTable("collaborations", {
  id: id().primaryKey(),
  title: varchar("title", { length: 200 }).notNull(),
  type: mysqlEnum("type", ["api-integration", "event-integration", "data-contract", "release-coordination", "custom"]).notNull(),
  status: mysqlEnum("status", ["draft", "negotiating", "accepted", "in_progress", "validating", "completed", "rejected"]).notNull().default("draft"),
  objective: text("objective").notNull(),
  createdById: varchar("created_by_id", { length: 36 }).notNull().references(() => users.id),
  negotiationRound: int("negotiation_round").notNull().default(0),
  maxNegotiationRounds: int("max_negotiation_rounds").notNull().default(12),
  ...timestamps,
});

export const participants = mysqlTable("participants", {
  id: id().primaryKey(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  projectId: varchar("project_id", { length: 36 }).notNull().references(() => projects.id),
  agentId: varchar("agent_id", { length: 36 }).references(() => agents.id),
  role: mysqlEnum("role", ["coordinator", "provider", "consumer", "reviewer", "participant"]).notNull().default("participant"),
  approvalRequired: boolean("approval_required").notNull().default(true),
  status: mysqlEnum("status", ["invited", "active", "declined"]).notNull().default("invited"),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
}, (table) => [
  uniqueIndex("participants_collab_project_unique").on(table.collaborationId, table.projectId),
  index("participants_collab_idx").on(table.collaborationId),
]);

export const messages = mysqlTable("messages", {
  id: id().primaryKey(),
  sequence: int("sequence").autoincrement().notNull().unique(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  participantId: varchar("participant_id", { length: 36 }).references(() => participants.id),
  authorType: mysqlEnum("author_type", ["user", "agent", "system"]).notNull(),
  authorName: varchar("author_name", { length: 200 }).notNull(),
  kind: mysqlEnum("kind", ["chat", "question", "clarification", "objection", "status", "system"]).notNull().default("chat"),
  body: text("body").notNull(),
  metadata: json("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
}, (table) => [index("messages_collab_created_idx").on(table.collaborationId, table.createdAt)]);

export const artifacts = mysqlTable("artifacts", {
  id: id().primaryKey(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 200 }).notNull(),
  type: mysqlEnum("type", ["openapi", "asyncapi", "json-schema", "markdown", "test-plan", "test-report", "custom"]).notNull(),
  currentVersion: int("current_version").notNull().default(1),
  ...timestamps,
});

export const artifactVersions = mysqlTable("artifact_versions", {
  id: id().primaryKey(),
  artifactId: varchar("artifact_id", { length: 36 }).notNull().references(() => artifacts.id, { onDelete: "cascade" }),
  version: int("version").notNull(),
  content: text("content").notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  createdByParticipantId: varchar("created_by_participant_id", { length: 36 }).references(() => participants.id),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
}, (table) => [uniqueIndex("artifact_versions_version_unique").on(table.artifactId, table.version)]);

export const proposals = mysqlTable("proposals", {
  id: id().primaryKey(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  artifactVersionId: varchar("artifact_version_id", { length: 36 }).references(() => artifactVersions.id),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body").notNull(),
  status: mysqlEnum("status", ["open", "accepted", "rejected", "superseded"]).notNull().default("open"),
  approvalMode: mysqlEnum("approval_mode", ["all", "required"]).notNull().default("required"),
  createdByParticipantId: varchar("created_by_participant_id", { length: 36 }).references(() => participants.id),
  ...timestamps,
});

export const approvals = mysqlTable("approvals", {
  id: id().primaryKey(),
  proposalId: varchar("proposal_id", { length: 36 }).notNull().references(() => proposals.id, { onDelete: "cascade" }),
  participantId: varchar("participant_id", { length: 36 }).notNull().references(() => participants.id, { onDelete: "cascade" }),
  artifactVersionId: varchar("artifact_version_id", { length: 36 }).references(() => artifactVersions.id),
  decision: mysqlEnum("decision", ["approved", "rejected"]).notNull(),
  comment: text("comment").notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
}, (table) => [uniqueIndex("approvals_proposal_participant_unique").on(table.proposalId, table.participantId)]);

export const workItems = mysqlTable("work_items", {
  id: id().primaryKey(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  proposalId: varchar("proposal_id", { length: 36 }).references(() => proposals.id),
  assigneeParticipantId: varchar("assignee_participant_id", { length: 36 }).references(() => participants.id),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description").notNull(),
  status: mysqlEnum("status", ["pending", "in_progress", "blocked", "validating", "completed", "rejected"]).notNull().default("pending"),
  priority: mysqlEnum("priority", ["low", "normal", "high", "critical"]).notNull().default("normal"),
  acceptanceCriteria: text("acceptance_criteria").notNull(),
  ...timestamps,
});

export const dependencies = mysqlTable("dependencies", {
  id: id().primaryKey(),
  workItemId: varchar("work_item_id", { length: 36 }).notNull().references(() => workItems.id, { onDelete: "cascade" }),
  dependsOnId: varchar("depends_on_id", { length: 36 }).notNull().references(() => workItems.id, { onDelete: "cascade" }),
}, (table) => [uniqueIndex("dependencies_unique").on(table.workItemId, table.dependsOnId)]);

export const credentials = mysqlTable("credentials", {
  id: id().primaryKey(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  ownerParticipantId: varchar("owner_participant_id", { length: 36 }).notNull().references(() => participants.id),
  recipientParticipantId: varchar("recipient_participant_id", { length: 36 }).notNull().references(() => participants.id),
  name: varchar("name", { length: 200 }).notNull(),
  type: mysqlEnum("type", ["api-token", "test-account", "webhook-secret", "oauth-client"]).notNull(),
  environment: varchar("environment", { length: 50 }).notNull().default("test"),
  purpose: text("purpose").notNull(),
  status: mysqlEnum("status", ["requested", "offered", "approved", "granted", "revoked", "rejected", "expired"]).notNull().default("requested"),
  ciphertext: text("ciphertext"),
  encryptedDek: text("encrypted_dek"),
  iv: varchar("iv", { length: 32 }),
  authTag: varchar("auth_tag", { length: 32 }),
  expiresAt: timestamp("expires_at", { fsp: 3 }),
  approvedAt: timestamp("approved_at", { fsp: 3 }),
  grantedAt: timestamp("granted_at", { fsp: 3 }),
  ...timestamps,
});

export const acceptanceRuns = mysqlTable("acceptance_runs", {
  id: id().primaryKey(),
  sequence: int("sequence").autoincrement().notNull().unique(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  workItemId: varchar("work_item_id", { length: 36 }).references(() => workItems.id),
  participantId: varchar("participant_id", { length: 36 }).notNull().references(() => participants.id),
  artifactVersionId: varchar("artifact_version_id", { length: 36 }).references(() => artifactVersions.id),
  status: mysqlEnum("status", ["passed", "failed"]).notNull(),
  summary: text("summary").notNull(),
  evidence: json("evidence").notNull().default({}),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
});

export const connectorJobs = mysqlTable("connector_jobs", {
  id: id().primaryKey(),
  sequence: int("sequence").autoincrement().notNull().unique(),
  agentId: varchar("agent_id", { length: 36 }).notNull().references(() => agents.id, { onDelete: "cascade" }),
  collaborationId: varchar("collaboration_id", { length: 36 }).references(() => collaborations.id, { onDelete: "cascade" }),
  kind: mysqlEnum("kind", ["collaboration.turn", "a2a.message", "local.test"]).notNull(),
  payload: json("payload").notNull(),
  status: mysqlEnum("status", ["pending", "running", "completed", "failed", "cancelled"]).notNull().default("pending"),
  result: json("result"),
  error: text("error"),
  attempts: int("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
  leaseUntil: timestamp("lease_until", { fsp: 3 }),
  ...timestamps,
}, (table) => [index("connector_jobs_agent_status_idx").on(table.agentId, table.status, table.availableAt)]);

export const auditEvents = mysqlTable("audit_events", {
  id: id().primaryKey(),
  sequence: int("sequence").autoincrement().notNull().unique(),
  collaborationId: varchar("collaboration_id", { length: 36 }).references(() => collaborations.id, { onDelete: "cascade" }),
  actorType: mysqlEnum("actor_type", ["user", "agent", "connector", "system"]).notNull(),
  actorId: varchar("actor_id", { length: 100 }),
  action: varchar("action", { length: 100 }).notNull(),
  metadata: json("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().default(sql`(now(3))`),
}, (table) => [index("audit_collab_created_idx").on(table.collaborationId, table.createdAt)]);

// Optional managed lifecycle. Legacy collaborations keep their existing workflow.
export const collaborationLifecycles = mysqlTable("collaboration_lifecycles", {
  collaborationId: varchar("collaboration_id", { length: 36 }).primaryKey().references(() => collaborations.id, { onDelete: "cascade" }),
  revision: int("revision").notNull().default(1),
  phase: mysqlEnum("phase", ["planning", "plan_confirmation", "awaiting_approval", "executing", "awaiting_review", "terminated"]).notNull().default("planning"),
  requiredParticipantIds: json("required_participant_ids").$type<string[]>().notNull(),
  documentHash: varchar("document_hash", { length: 64 }),
  approvedHash: varchar("approved_hash", { length: 64 }),
  approvedById: varchar("approved_by_id", { length: 36 }).references(() => users.id),
  approvedAt: timestamp("approved_at", { fsp: 3 }),
  terminatedById: varchar("terminated_by_id", { length: 36 }).references(() => users.id),
  terminatedAt: timestamp("terminated_at", { fsp: 3 }),
  ...timestamps,
});

export const lifecycleRevisions = mysqlTable("lifecycle_revisions", {
  id: id().primaryKey(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  revision: int("revision").notNull(),
  requirements: longtext("requirements").notNull(),
  document: longtext("document"),
  documentHash: varchar("document_hash", { length: 64 }),
  report: longtext("report"),
  createdById: varchar("created_by_id", { length: 36 }).notNull().references(() => users.id),
  ...timestamps,
}, (table) => [uniqueIndex("lifecycle_revisions_collab_revision_unique").on(table.collaborationId, table.revision)]);

export const lifecycleContributions = mysqlTable("lifecycle_contributions", {
  id: id().primaryKey(),
  collaborationId: varchar("collaboration_id", { length: 36 }).notNull().references(() => collaborations.id, { onDelete: "cascade" }),
  revision: int("revision").notNull(),
  participantId: varchar("participant_id", { length: 36 }).notNull().references(() => participants.id),
  content: longtext("content"),
  confirmedHash: varchar("confirmed_hash", { length: 64 }),
  reportStatus: mysqlEnum("report_status", ["passed", "failed"]),
  reportSummary: longtext("report_summary"),
  reportEvidence: json("report_evidence").$type<Record<string, unknown>>(),
  ...timestamps,
}, (table) => [uniqueIndex("lifecycle_contributions_collab_revision_participant_unique").on(table.collaborationId, table.revision, table.participantId)]);
