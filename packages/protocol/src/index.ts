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
export const requirementSchema = z.object({ id: z.string().min(1).max(100), text: z.string().min(1).max(10_000) });
export const serviceExpectationSchema = z.object({
  name: z.string().min(1).max(100), publisherParticipantId: idSchema,
  healthPath: z.string().min(1).max(1000), status: z.number().int().min(200).max(299),
  bodyChecks: z.array(z.object({ path: z.string().min(1).max(200), equals: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]) })).max(30),
});
export const sharedContractSchema = z.object({
  // Optional only for reading documents approved by older versions.
  effectiveRequirements: z.array(requirementSchema).min(1).max(200).optional(),
  retiredRequirements: z.array(z.object({ id: z.string().min(1).max(100), reason: z.string().min(1).max(5000) })).max(200).optional(),
  serviceExpectations: z.array(serviceExpectationSchema).max(30).optional(),
  scope: z.string().min(20).max(20_000),
  interfaces: z.array(z.object({ id: z.string().min(1).max(100), definition: z.string().min(20).max(20_000) })).min(1).max(30),
  responsibilities: z.array(z.object({ participantId: idSchema, changes: z.string().min(20).max(20_000) })).min(2).max(50),
  acceptanceCases: z.array(z.object({
    id: z.string().min(1).max(100), runnerParticipantId: idSchema,
    description: z.string().min(10).max(5000), command: z.string().min(1).max(2000), expectedResult: z.string().min(1).max(5000),
    requiredAssertions: z.array(z.string().min(1).max(500)).min(1).max(100).optional(),
  })).min(2).max(100),
  risks: z.string().min(1).max(10_000),
  changeSummary: z.string().min(10).max(10_000),
  impactedParticipantIds: z.array(idSchema).min(1).max(50),
  retainedDecisions: z.array(z.string().min(1).max(5000)).max(100).default([]),
});
export type SharedContract = z.infer<typeof sharedContractSchema>;
export const commandEvidenceSchema = z.object({
  id: z.string().min(1).max(100), command: z.string().max(10_000), invocation: z.string().max(10_000).optional(), exitCode: z.number().int().nullable(),
  output: z.string().max(100_000), assertions: z.array(z.string().max(2000)).max(500),
  source: z.enum(["codex-app-server", "local-test"]), capturedAt: z.string(),
});
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
export const informationSourceSchema = z.object({
  scope: z.enum(["local_project", "shared_context", "runtime"]),
  reference: z.string().min(1).max(1000), finding: z.string().min(1).max(2000),
});
export const informationResponseSchema = z.object({
  participantId: idSchema, mode: z.enum(["local", "peer"]), status: z.enum(["found", "unavailable"]),
  answer: z.string().min(1).max(10_000), sources: z.array(informationSourceSchema).min(1).max(20),
});
export const informationRequestSchema = z.object({
  id: idSchema, revision: z.number().int().positive(), phase: z.string(), question: z.string().min(1).max(5000),
  requestedByParticipantId: idSchema, targetParticipantIds: z.array(idSchema),
  stage: z.enum(["local", "peer"]), status: z.enum(["pending", "answered", "needs_admin"]),
  answer: z.string().nullable(), createdAt: z.string(), responses: z.array(informationResponseSchema).max(51),
  administratorResolution: z.object({ answer: z.string(), providedAt: z.string() }).optional(),
});
export type InformationRequest = z.infer<typeof informationRequestSchema>;
export const repairContextSchema = z.object({
  sourceRevision: z.number().int().positive(), sourceDocumentHash: z.string().nullable(), sourceReportHash: z.string().length(64),
  cycle: z.number().int().positive(), failures: z.array(z.object({
    participantId: idSchema, stage: z.enum(["executing", "joint_verifying"]), caseId: z.string().nullable(),
    status: z.enum(["failed", "not_run"]), summary: z.string(),
  })).min(1),
});
export const workflowBlockSchema = z.object({
  kind: z.enum(["waiting_peer", "retryable", "needs_admin", "gathering_info"]), reason: z.string().min(10).max(5000),
  dependencyParticipantIds: z.array(idSchema).max(50).default([]), retryAfterSeconds: z.number().int().min(1).max(300).default(5),
  requiresAuthorization: z.boolean().optional(),
});
export const servicePublicationSchema = z.object({
  name: z.string().min(1).max(100), baseUrl: z.string().url().max(2000), healthPath: z.string().max(1000),
  ttlSeconds: z.number().int().min(30).max(3600).default(300),
  probe: z.object({ ok: z.boolean(), status: z.number().int().nullable(), checkedAt: z.string(),
    expectationHash: z.string().length(64).optional(), documentHash: z.string().length(64).optional(), revision: z.number().int().positive().optional(),
  }).optional(),
});
export const integrationCheckSchema = z.object({
  caseId: z.string().min(1).max(100), status: z.enum(["passed", "failed", "not_run"]),
  command: z.string().max(2000), summary: z.string().min(1).max(10_000),
  evidence: z.record(z.string(), z.unknown()).default({}),
  assertionNames: z.array(z.string().min(1).max(2000)).max(100).default([]),
  runIds: z.array(z.string().min(1).max(100)).max(100).default([]),
});
export const lifecyclePhaseSchema = z.enum(["planning", "plan_synthesis", "plan_confirmation", "awaiting_approval", "executing", "joint_verifying", "awaiting_review", "terminated"]);
export const lifecycleAgentActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan.submit"), revision: z.number().int().positive(), content: z.string().min(100).max(100_000), baseline: workspaceBaselineSchema.optional() }),
  z.object({ type: z.literal("plan.compose"), revision: z.number().int().positive(), baseDocumentHash: z.string().length(64).nullable(), contract: sharedContractSchema }),
  z.object({ type: z.literal("plan.reject"), revision: z.number().int().positive(), documentHash: z.string().length(64), reason: z.string().min(10).max(10_000) }),
  z.object({ type: z.literal("plan.confirm"), revision: z.number().int().positive(), documentHash: z.string().length(64) }),
  z.object({ type: z.literal("execution.report"), revision: z.number().int().positive(), status: z.enum(["passed", "failed"]), summary: z.string().min(1).max(20_000), evidence: z.record(z.string(), z.unknown()).default({}), runs: z.array(commandEvidenceSchema).max(200).default([]) }),
  z.object({ type: z.literal("integration.report"), revision: z.number().int().positive(), documentHash: z.string().length(64), checks: z.array(integrationCheckSchema).min(1).max(100), runs: z.array(commandEvidenceSchema).max(200).default([]) }),
  z.object({ type: z.literal("workflow.blocked"), revision: z.number().int().positive(), ...workflowBlockSchema.shape }),
  z.object({ type: z.literal("service.publish"), revision: z.number().int().positive(), ...servicePublicationSchema.shape }),
  z.object({ type: z.literal("information.request"), revision: z.number().int().positive(), question: z.string().min(10).max(5000), searched: z.array(informationSourceSchema).min(2).max(20) }),
  z.object({ type: z.literal("information.respond"), revision: z.number().int().positive(), requestId: idSchema,
    status: z.enum(["found", "unavailable"]), answer: z.string().min(1).max(10_000), sources: z.array(informationSourceSchema).min(1).max(20) }),
]);
export type LifecycleAgentAction = z.infer<typeof lifecycleAgentActionSchema>;
export function lifecycleActions(phase: string, informationOnly = false): string[] {
  if (informationOnly) return ["information.respond"];
  const actions: Record<string, string[]> = { planning: ["plan.submit"], plan_synthesis: ["plan.compose"], plan_confirmation: ["plan.confirm", "plan.reject", "plan.submit"],
    executing: ["execution.report", "artifact.upsert", "work.create", "work.update", "acceptance.submit", "service.publish"], joint_verifying: ["integration.report", "service.publish"] };
  return actions[phase] ? [...actions[phase]!, "workflow.blocked", "information.request"] : [];
}
export const lifecycleContextSchema = z.object({
  revision: z.number().int().positive(), phase: lifecyclePhaseSchema, requirements: z.string(),
  document: z.string().nullable(), documentHash: z.string().nullable(), approvedHash: z.string().nullable(),
  requiredParticipantIds: z.array(idSchema),
  coordinatorParticipantId: idSchema.optional(), paused: z.boolean().default(false),
  changeRequest: z.string().nullable().optional(), contract: sharedContractSchema.nullable().optional(),
  repair: repairContextSchema.nullish(), informationRequests: z.array(informationRequestSchema).max(150).default([]),
  objections: z.array(z.object({ participantId: idSchema, documentHash: z.string(), reason: z.string() })).default([]),
  baseline: z.object({ revision: z.number(), documentHash: z.string().nullable(), document: z.string().nullable(), contract: sharedContractSchema.nullable(), report: z.string().nullable(), informationRequests: z.array(informationRequestSchema).optional() }).nullable().optional(),
  contributions: z.array(z.object({ participantId: idSchema, content: z.string(), baseline: workspaceBaselineSchema.nullable().optional() })),
  confirmations: z.array(idSchema),
  reports: z.array(z.object({ participantId: idSchema, status: z.enum(["passed", "failed"]), summary: z.string(), evidence: z.record(z.string(), z.unknown()) })),
  integrationReports: z.array(z.object({ participantId: idSchema, checks: z.array(integrationCheckSchema) })).default([]),
  report: z.string().nullable(),
  blocks: z.array(workflowBlockSchema.extend({ participantId: idSchema, phase: z.string(), attempts: z.number(), retryAt: z.string().nullable(), informationRequestId: idSchema.optional() })).default([]),
  services: z.array(servicePublicationSchema.extend({ participantId: idSchema, expiresAt: z.string() })).default([]),
  evidenceRuns: z.array(commandEvidenceSchema.extend({ participantId: idSchema })).default([]),
});
export type LifecycleContext = z.infer<typeof lifecycleContextSchema>;

/** A fact lookup is always a separate, read-only turn, including during execution. */
export function informationTaskFor(lifecycle: LifecycleContext, participantId: string) {
  if (lifecycle.paused || lifecycle.phase === "terminated") return null;
  for (const request of lifecycle.informationRequests ?? []) {
    if (request.status !== "pending" || request.revision !== lifecycle.revision || request.phase !== lifecycle.phase) continue;
    if (request.stage === "local" && request.requestedByParticipantId === participantId && !request.responses.some(row => row.mode === "local")) return { requestId: request.id, mode: "local" as const };
    if (request.stage === "peer" && request.targetParticipantIds.includes(participantId) && !request.responses.some(row => row.mode === "peer" && row.participantId === participantId)) return { requestId: request.id, mode: "peer" as const };
  }
  return null;
}

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

export const tokenUsageBreakdownSchema = z.object({
  inputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(), reasoningOutputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative().default(0),
});
export const adapterTelemetrySchema = z.object({
  version: z.literal(1), threadId: z.string(), turnId: z.string(), jobId: z.string().optional(), revision: z.number().optional(), phase: z.string().optional(),
  promptBytes: z.number().nonnegative(), schemaBytes: z.number().nonnegative(), commandOutputBytes: z.number().nonnegative(),
  resourceCommandOutputBytes: z.number().nonnegative(), resourceReadCommands: z.number().nonnegative(), durationMs: z.number().nonnegative(),
  resourceStats: z.object({ createdBytes: z.number(), availableBytes: z.number(), files: z.number(), prunedFiles: z.number() }),
  contextCompacted: z.boolean(), model: z.string().optional(),
  tokenUsage: z.object({ threadTotal: tokenUsageBreakdownSchema, lastModelCall: tokenUsageBreakdownSchema, turnDelta: tokenUsageBreakdownSchema.nullable() }).nullable(),
});
export type AdapterTelemetry = z.infer<typeof adapterTelemetrySchema>;

export const collaborationContextSchema = z.object({
  lifecycle: lifecycleContextSchema.nullish(),
  informationTask: z.object({ requestId: idSchema, mode: z.enum(["local", "peer"]) }).nullish(),
  localDiscovery: z.object({ files: z.array(z.string()).max(100), testCommands: z.array(z.string()).max(20) }).optional(),
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

/** Stable across JSON database key ordering and independently parsed clients. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value)])) : item;
  return JSON.stringify(normalize(value));
}

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
