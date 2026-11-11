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

export const agentActionSchema = z.discriminatedUnion("type", [
  artifactUpsertActionSchema,
  proposalCreateActionSchema,
  proposalDecisionActionSchema,
  workCreateActionSchema,
  workUpdateActionSchema,
  credentialRequestActionSchema,
  acceptanceSubmitActionSchema,
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
