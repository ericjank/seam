import { agentTurnResultSchema, sharedContractSchema, informationSourceSchema, ARTIFACT_TYPES, CREDENTIAL_TYPES, WORK_STATUSES, type AgentTurnResult } from "@seam/protocol";
import { z } from "zod";
import type { AgentRunInput } from "./types.js";

const id = z.string().uuid();
const title = z.string().min(1).max(200);
const summary = z.string().min(1).max(20_000);
const evidence = z.object({
  details: z.string().min(1).max(100_000).describe("Markdown evidence with actual test commands, results, changed relative paths and remaining limitations. Never include credentials or full source files."),
}).strict();
const category = z.enum(["code", "environment", "missing_information", "authorization", "unknown"]);
const nativeSource = informationSourceSchema.omit({ contentHash: true, sourceVersion: true }).extend({ sourceVersion: z.string().max(200).nullable() }).strict();
const nativeCases = z.array(sharedContractSchema.shape.acceptanceCases.element.required()).min(2).max(100);
const nativeContract = sharedContractSchema.extend({ acceptanceCases: nativeCases }).required();
const nativeDelta = z.object({
  scope: sharedContractSchema.shape.scope.nullable(), interfaces: sharedContractSchema.shape.interfaces.nullable(),
  responsibilities: sharedContractSchema.shape.responsibilities.nullable(), acceptanceCases: nativeCases.nullable(),
  serviceExpectations: sharedContractSchema.shape.serviceExpectations.unwrap().nullable(),
  risks: sharedContractSchema.shape.risks.nullable(), changeSummary: sharedContractSchema.shape.changeSummary,
  impactedParticipantIds: sharedContractSchema.shape.impactedParticipantIds, retainedDecisions: z.array(z.string().min(1).max(5000)).max(100).nullable(),
  testChanges: sharedContractSchema.shape.testChanges.unwrap().nullable(),
}).strict();

// Native Structured Outputs require every property to be required and every
// object to be closed. Nullable placeholders model protocol optional fields;
// they are removed only after validating the complete native response.
const auxiliaryActions = {
  "artifact.upsert": z.object({ type: z.literal("artifact.upsert"), artifactId: id.nullable(), title, artifactType: z.enum(ARTIFACT_TYPES), content: z.string().min(1).max(1_000_000) }).strict(),
  "proposal.create": z.object({ type: z.literal("proposal.create"), title, body: z.string().min(1).max(50_000), artifactId: id.nullable(), approvalMode: z.enum(["all", "required"]) }).strict(),
  "proposal.decide": z.object({ type: z.literal("proposal.decide"), proposalId: id, decision: z.enum(["approved", "rejected"]), comment: z.string().max(5000) }).strict(),
  "work.create": z.object({ type: z.literal("work.create"), title, description: z.string().max(20_000), assigneeParticipantId: id.nullable(), priority: z.enum(["low", "normal", "high", "critical"]), acceptanceCriteria: z.string().max(20_000), dependsOn: z.array(id).max(50) }).strict(),
  "work.update": z.object({ type: z.literal("work.update"), workItemId: id, status: z.enum(WORK_STATUSES).nullable(), summary: z.string().max(20_000).nullable() }).strict(),
  "credential.request": z.object({ type: z.literal("credential.request"), ownerParticipantId: id, name: title, credentialType: z.enum(CREDENTIAL_TYPES), environment: z.string().min(1).max(50), purpose: z.string().min(1).max(5000), expiresAt: z.string().datetime().nullable() }).strict(),
  "acceptance.submit": z.object({ type: z.literal("acceptance.submit"), workItemId: id.nullable(), artifactId: id.nullable(), status: z.enum(["passed", "failed"]), summary, evidence }).strict(),
};

function nativeResponseSchema(input: AgentRunInput) {
  const lifecycle = input.context?.lifecycle;
  let actions: z.ZodType[];
  if (!lifecycle) actions = Object.values(auxiliaryActions);
  else if (input.context?.informationTask && !lifecycle.paused) {
    actions = [z.object({ type: z.literal("information.respond"), revision: z.literal(lifecycle.revision), requestId: z.literal(input.context.informationTask.requestId),
      attempt: z.literal(input.context.informationTask.attempt ?? 1), value: z.string().max(10_000), validForSeconds: z.number().int().min(30).max(86400),
      status: z.enum(["found", "unavailable"]), answer: z.string().min(1).max(10_000), sources: z.array(nativeSource).min(1).max(20) }).strict()];
  }
  else {
    const blocked = z.object({ type: z.literal("workflow.blocked"), revision: z.literal(lifecycle.revision), kind: z.enum(["waiting_peer", "retryable", "needs_admin"]), reason: z.string().min(10).max(5000), dependencyParticipantIds: z.array(id).max(50), retryAfterSeconds: z.number().int().min(1).max(300), requiresAuthorization: z.boolean(), requiresReview: z.boolean(), category }).strict();
    const publish = z.object({ type: z.literal("service.publish"), revision: z.literal(lifecycle.revision), name: z.string().min(1).max(100), baseUrl: z.string().url().max(2000), healthPath: z.string().max(1000), ttlSeconds: z.number().int().min(30).max(3600) }).strict();
    const submit = z.object({ type: z.literal("plan.submit"), revision: z.literal(lifecycle.revision), content: z.string().min(100).max(100_000) }).strict();
    switch (lifecycle.paused ? "paused" : lifecycle.phase) {
      case "planning": actions = [submit]; if (lifecycle.repair) actions.unshift(z.object({ type: z.literal("plan.amend"), revision: z.literal(lifecycle.revision), changes: z.string().min(20).max(20_000) }).strict()); break;
      case "plan_synthesis":
        actions = [z.object({ type: z.literal("plan.compose"), revision: z.literal(lifecycle.revision), baseDocumentHash: lifecycle.documentHash ? z.literal(lifecycle.documentHash) : z.null(), contract: nativeContract }).strict()];
        if (lifecycle.repair && lifecycle.baseline?.documentHash) actions.unshift(z.object({ type: z.literal("plan.patch"), revision: z.literal(lifecycle.revision), baseDocumentHash: z.literal(lifecycle.documentHash ?? lifecycle.baseline.documentHash), delta: nativeDelta }).strict());
        break;
      case "plan_confirmation":
        actions = [submit];
        // A missing/invalid snapshot cannot be confirmed, even by a response
        // that bypasses the model-side schema. It can still be revised.
        if (lifecycle.documentHash?.length === 64) actions.push(
          z.object({ type: z.literal("plan.confirm"), revision: z.literal(lifecycle.revision), documentHash: z.literal(lifecycle.documentHash) }).strict(),
          z.object({ type: z.literal("plan.reject"), revision: z.literal(lifecycle.revision), documentHash: z.literal(lifecycle.documentHash), reason: z.string().min(10).max(10_000) }).strict(),
        );
        break;
      case "executing": actions = [
        z.object({ type: z.literal("execution.report"), revision: z.literal(lifecycle.revision), status: z.enum(["passed", "failed"]), summary, evidence, category }).strict(),
        auxiliaryActions["artifact.upsert"], auxiliaryActions["work.create"], auxiliaryActions["work.update"], auxiliaryActions["acceptance.submit"],
        publish,
      ]; break;
      case "joint_verifying": actions = [z.object({ type: z.literal("integration.report"), revision: z.literal(lifecycle.revision), documentHash: z.literal(lifecycle.documentHash), checks: z.array(z.object({
        caseId: z.string().min(1).max(100), status: z.enum(["passed", "failed", "not_run"]), command: z.string().max(2000), summary: z.string().min(1).max(10_000), assertionNames: z.array(z.string().min(1).max(2000)).max(100), evidence, category,
      }).strict()).min(1).max(100) }).strict(), publish]; break;
      default: actions = [];
    }
    if (actions.length) actions.push(blocked, z.object({ type: z.literal("information.request"), revision: z.literal(lifecycle.revision), question: z.string().min(10).max(5000), searched: z.array(nativeSource).min(2).max(20), key: z.string().min(1).max(200).nullable(), fresh: z.boolean() }).strict());
  }
  const item = actions.length === 0 ? z.object({}).strict()
    : actions.length === 1 ? actions[0]!
    : z.union(actions as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  return z.object({
    message: z.string().min(1).max(50_000).describe("Readable Chinese summary for the user; actual machine actions belong in actions."),
    kind: z.enum(["chat", "question", "clarification", "objection", "status"]),
    actions: z.array(item).max(actions.length === 0 ? 0 : 50),
    notifyParticipantIds: z.array(id).max(50),
    needsHumanInput: z.boolean(),
  }).strict();
}

/** Schema belongs in turn/start.outputSchema, never in the user message. */
export function buildNativeOutputSchema(input: AgentRunInput): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(nativeResponseSchema(input));
  // Zod emits the same long UUID regex for every identifier. The model-side
  // UUID format is sufficient; the local parser still validates the UUID.
  const compact = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(compact); return; }
    const record = node as Record<string, unknown>;
    delete record.default;
    if (record.format === "uuid") delete record.pattern;
    // Native Structured Outputs accepts a subset of JSON Schema formats.
    // URL syntax remains enforced by the local Zod parser and health probe.
    if (record.format === "uri") delete record.format;
    Object.values(record).forEach(compact);
  };
  compact(schema);
  return schema;
}

const optionalFields: Record<string, string[]> = {
  "artifact.upsert": ["artifactId"], "proposal.create": ["artifactId"], "work.create": ["assigneeParticipantId"],
  "work.update": ["status", "summary"], "credential.request": ["expiresAt"], "acceptance.submit": ["workItemId", "artifactId"],
};

/** Reject prose, stale revisions and out-of-stage actions before publication. */
export function parseNativeAgentOutput(raw: string, input: AgentRunInput): AgentTurnResult {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Codex App Server 未返回有效结构化 JSON；未发布本轮结果"); }
  const parsed = nativeResponseSchema(input).safeParse(value);
  if (!parsed.success) throw new Error("Codex App Server 结构化回复不符合当前阶段或 revision/documentHash；未发布本轮结果");
  const normalized = {
    ...parsed.data,
    actions: parsed.data.actions.map((action) => {
      const result = { ...(action as Record<string, unknown>) };
      for (const field of optionalFields[String(result.type)] ?? []) if (result[field] === null) delete result[field];
      if (result.type === "information.request" && result.key === null) delete result.key;
      if (result.type === "plan.patch") result.delta = Object.fromEntries(Object.entries(result.delta as Record<string, unknown>).filter(([, value]) => value !== null));
      return result;
    }),
  };
  return agentTurnResultSchema.parse(normalized);
}
