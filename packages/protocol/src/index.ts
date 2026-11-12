import { z } from "zod";

export const COLLABORATION_TYPES = [
  "api-integration",
  "event-integration",
  "data-contract",
  "release-coordination",
  "custom",
] as const;
export const COLLABORATION_STATUSES = [
  "draft",
  "negotiating",
  "accepted",
  "in_progress",
  "validating",
  "completed",
  "rejected",
] as const;
export const ARTIFACT_TYPES = [
  "openapi",
  "asyncapi",
  "json-schema",
  "markdown",
  "test-plan",
  "test-report",
  "custom",
] as const;
export const CREDENTIAL_TYPES = [
  "api-token",
  "test-account",
  "webhook-secret",
  "oauth-client",
] as const;
export const WORK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "validating",
  "completed",
  "rejected",
] as const;

export const idSchema = z.string().uuid();
export const collaborationTypeSchema = z.enum(COLLABORATION_TYPES);
export const collaborationStatusSchema = z.enum(COLLABORATION_STATUSES);
export const artifactTypeSchema = z.enum(ARTIFACT_TYPES);
export const credentialTypeSchema = z.enum(CREDENTIAL_TYPES);
export const workStatusSchema = z.enum(WORK_STATUSES);

export const participantSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  projectName: z.string(),
  agentId: idSchema.nullable(),
  agentName: z.string().nullable(),
  role: z.enum(["coordinator", "provider", "consumer", "reviewer", "participant"]),
  approvalRequired: z.boolean(),
  status: z.enum(["invited", "active", "declined"]),
});
export type Participant = z.infer<typeof participantSchema>;

export const collaborationMessageSchema = z.object({
  id: idSchema,
  participantId: idSchema.nullable(),
  authorType: z.enum(["user", "agent", "system"]),
  authorName: z.string(),
  kind: z.enum(["chat", "question", "clarification", "objection", "status", "system"]),
  body: z.string().min(1).max(50_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type CollaborationMessage = z.infer<typeof collaborationMessageSchema>;

export const artifactVersionSchema = z.object({
  id: idSchema,
  artifactId: idSchema,
  version: z.number().int().positive(),
  content: z.string().min(1).max(1_000_000),
  contentHash: z.string().length(64),
  createdByParticipantId: idSchema.nullable(),
  createdAt: z.string(),
});
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

export const artifactSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(200),
  type: artifactTypeSchema,
  currentVersion: z.number().int().positive(),
  versions: z.array(artifactVersionSchema).default([]),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const workItemSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(""),
  assigneeParticipantId: idSchema.nullable(),
  status: workStatusSchema,
  priority: z.enum(["low", "normal", "high", "critical"]),
  acceptanceCriteria: z.string().max(20_000).default(""),
  dependsOn: z.array(idSchema).default([]),
});
export type WorkItem = z.infer<typeof workItemSchema>;

export const artifactUpsertActionSchema = z.object({
  type: z.literal("artifact.upsert"),
  artifactId: idSchema.optional(),
  title: z.string().min(1).max(200),
  artifactType: artifactTypeSchema,
  content: z.string().min(1).max(1_000_000),
});
export const proposalCreateActionSchema = z.object({
  type: z.literal("proposal.create"),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
  artifactId: idSchema.optional(),
  approvalMode: z.enum(["all", "required"]).default("required"),
});
export const proposalDecisionActionSchema = z.object({
  type: z.literal("proposal.decide"),
  proposalId: idSchema,
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(5000).default(""),
});
export const workCreateActionSchema = z.object({
  type: z.literal("work.create"),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(""),
  assigneeParticipantId: idSchema.optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  acceptanceCriteria: z.string().max(20_000).default(""),
  dependsOn: z.array(idSchema).max(50).default([]),
});
export const workUpdateActionSchema = z.object({
  type: z.literal("work.update"),
  workItemId: idSchema,
  status: workStatusSchema.optional(),
  summary: z.string().max(20_000).optional(),
});
export const credentialRequestActionSchema = z.object({
  type: z.literal("credential.request"),
  ownerParticipantId: idSchema,
  name: z.string().min(1).max(200),
  credentialType: credentialTypeSchema,
  environment: z.string().min(1).max(50).default("test"),
  purpose: z.string().min(1).max(5000),
  expiresAt: z.string().datetime().optional(),
});
export const acceptanceSubmitActionSchema = z.object({
  type: z.literal("acceptance.submit"),
  workItemId: idSchema.optional(),
  artifactId: idSchema.optional(),
  status: z.enum(["passed", "failed"]),
  summary: z.string().min(1).max(20_000),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

export const workspaceBaselineSchema = z.object({
  head: z.string().nullable(), treeHash: z.string(), capturedAt: z.string(),
});
export const sharedContractSchema = z.object({
  scope: z.string().min(20).max(20_000),
  interfaces: z.array(z.object({ id: z.string().min(1).max(100), definition: z.string().min(20).max(20_000) })).min(1).max(30),
  responsibilities: z.array(z.object({ participantId: idSchema, changes: z.string().min(20).max(20_000) })).min(2).max(50),
  acceptanceCases: z.array(z.object({
    id: z.string().min(1).max(100), runnerParticipantId: idSchema,
    description: z.string().min(10).max(5000), command: z.string().min(1).max(2000), expectedResult: z.string().min(1).max(5000),
  })).min(2).max(100),
  risks: z.string().min(1).max(10_000),
  changeSummary: z.string().min(10).max(10_000),
  impactedParticipantIds: z.array(idSchema).min(1).max(50),
  retainedDecisions: z.array(z.string().min(1).max(5000)).max(100).default([]),
});
export type SharedContract = z.infer<typeof sharedContractSchema>;
export const integrationCheckSchema = z.object({
  caseId: z.string().min(1).max(100), status: z.enum(["passed", "failed", "not_run"]),
  command: z.string().max(2000), summary: z.string().min(1).max(10_000),
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export const lifecyclePhaseSchema = z.enum(["planning", "plan_synthesis", "plan_confirmation", "awaiting_approval", "executing", "joint_verifying", "awaiting_review", "terminated"]);
export const lifecycleAgentActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan.submit"), revision: z.number().int().positive(), content: z.string().min(100).max(100_000), baseline: workspaceBaselineSchema.optional() }),
  z.object({ type: z.literal("plan.compose"), revision: z.number().int().positive(), baseDocumentHash: z.string().length(64).nullable(), contract: sharedContractSchema }),
  z.object({ type: z.literal("plan.reject"), revision: z.number().int().positive(), documentHash: z.string().length(64), reason: z.string().min(10).max(10_000) }),
  z.object({ type: z.literal("plan.confirm"), revision: z.number().int().positive(), documentHash: z.string().length(64) }),
  z.object({ type: z.literal("execution.report"), revision: z.number().int().positive(), status: z.enum(["passed", "failed"]), summary: z.string().min(1).max(20_000), evidence: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ type: z.literal("integration.report"), revision: z.number().int().positive(), documentHash: z.string().length(64), checks: z.array(integrationCheckSchema).min(1).max(100) }),
]);
export type LifecycleAgentAction = z.infer<typeof lifecycleAgentActionSchema>;
export const lifecycleContextSchema = z.object({
  revision: z.number().int().positive(), phase: lifecyclePhaseSchema, requirements: z.string(),
  document: z.string().nullable(), documentHash: z.string().nullable(), approvedHash: z.string().nullable(),
  requiredParticipantIds: z.array(idSchema),
  coordinatorParticipantId: idSchema.optional(), paused: z.boolean().default(false),
  changeRequest: z.string().nullable().optional(), contract: sharedContractSchema.nullable().optional(),
  objections: z.array(z.object({ participantId: idSchema, documentHash: z.string(), reason: z.string() })).default([]),
  baseline: z.object({ revision: z.number(), documentHash: z.string().nullable(), document: z.string().nullable(), contract: sharedContractSchema.nullable(), report: z.string().nullable() }).nullable().optional(),
  contributions: z.array(z.object({ participantId: idSchema, content: z.string(), baseline: workspaceBaselineSchema.nullable().optional() })),
  confirmations: z.array(idSchema),
  reports: z.array(z.object({ participantId: idSchema, status: z.enum(["passed", "failed"]), summary: z.string(), evidence: z.record(z.string(), z.unknown()) })),
  integrationReports: z.array(z.object({ participantId: idSchema, checks: z.array(integrationCheckSchema) })).default([]),
  report: z.string().nullable(),
});
export type LifecycleContext = z.infer<typeof lifecycleContextSchema>;

export const agentActionSchema = z.discriminatedUnion("type", [
  artifactUpsertActionSchema,
  proposalCreateActionSchema,
  proposalDecisionActionSchema,
  workCreateActionSchema,
  workUpdateActionSchema,
  credentialRequestActionSchema,
  acceptanceSubmitActionSchema,
  ...lifecycleAgentActionSchema.options,
]);
export type AgentAction = z.infer<typeof agentActionSchema>;

export const agentTurnResultSchema = z.object({
  message: z.string().min(1).max(50_000),
  kind: z.enum(["chat", "question", "clarification", "objection", "status"]).default("chat"),
  actions: z.array(agentActionSchema).max(50).default([]),
  notifyParticipantIds: z.array(idSchema).max(50).default([]),
  needsHumanInput: z.boolean().default(false),
});
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;

export const collaborationContextSchema = z.object({
  lifecycle: lifecycleContextSchema.nullish(),
  jobId: idSchema.optional(),
  collaborationId: idSchema,
  title: z.string(),
  type: collaborationTypeSchema,
  status: collaborationStatusSchema,
  objective: z.string(),
  participant: participantSchema,
  participants: z.array(participantSchema),
  messages: z.array(collaborationMessageSchema),
  artifacts: z.array(artifactSchema),
  workItems: z.array(workItemSchema),
  // Older user instructions remain visible even after the recent-message window moves on.
  instructions: z.array(collaborationMessageSchema).default([]),
  proposals: z.array(z.object({
    id: idSchema, title: z.string(), body: z.string(),
    status: z.enum(["open", "accepted", "rejected", "superseded"]),
    artifactVersionId: idSchema.nullable(), approvalMode: z.enum(["all", "required"]),
    approvals: z.array(z.object({ participantId: idSchema, decision: z.enum(["approved", "rejected"]), comment: z.string() })),
  })).default([]),
  credentialRequests: z.array(z.object({
    id: idSchema, ownerParticipantId: idSchema, recipientParticipantId: idSchema,
    name: z.string(), type: credentialTypeSchema, environment: z.string(), purpose: z.string(),
    status: z.enum(["requested", "offered", "approved", "granted", "revoked", "rejected", "expired"]),
    expiresAt: z.string().nullable(),
  })).default([]),
  acceptanceRuns: z.array(z.object({
    id: idSchema, workItemId: idSchema.nullable(), participantId: idSchema,
    artifactVersionId: idSchema.nullable(), status: z.enum(["passed", "failed"]),
    summary: z.string(), evidence: z.record(z.string(), z.unknown()), createdAt: z.string(),
  })).default([]),
});
export type CollaborationContext = z.infer<typeof collaborationContextSchema>;

export const connectorJobSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  collaborationId: idSchema.nullable(),
  kind: z.enum(["collaboration.turn", "a2a.message", "local.test"]),
  payload: z.record(z.string(), z.unknown()),
  attempts: z.number().int().nonnegative(),
  leaseUntil: z.string().optional(),
});
export type ConnectorJob = z.infer<typeof connectorJobSchema>;

export const connectorResultSchema = z.object({
  jobId: idSchema,
  attempts: z.number().int().positive().optional(),
  status: z.enum(["completed", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(10_000).optional(),
});
export type ConnectorResult = z.infer<typeof connectorResultSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export function contentHash(content: string): Promise<string> {
  return globalThis.crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(content))
    .then((buffer) =>
      Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}
