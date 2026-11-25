import { and, eq, lt, max, sql } from "drizzle-orm";
import { objectionTargetKey, type CollaborationContext, type LifecycleContext, type PlanObjectionTask } from "@seam/protocol";
import { z } from "zod";
import { db } from "@/db";
import { connectorJobs } from "@/db/schema";
import type { LifecycleSnapshot } from "@/services/lifecycle";

export type ThreadRetryPayload = {
  lifecycleSnapshot?: LifecycleSnapshot;
  context?: CollaborationContext;
  resumeThreadId?: string;
  retryOfFailedAttempt?: number;
};

export function legacyRetryScope(lifecycle: LifecycleContext | null, payload: ThreadRetryPayload, participantId: string): PlanObjectionTask | null {
  const { lifecycleSnapshot: snapshot, context } = payload;
  if (!lifecycle || lifecycle.paused || lifecycle.phase !== "plan_synthesis" || !snapshot ||
    snapshot.phase !== lifecycle.phase || snapshot.revision !== lifecycle.revision || snapshot.documentHash !== lifecycle.documentHash ||
    snapshot.approvedHash !== lifecycle.approvedHash || context?.participant.id !== participantId ||
    !lifecycle.requiredParticipantIds.includes(participantId)) return null;
  const assignment = context.planObjectionTask;
  const original = context.lifecycle?.planObjections?.find(row => row.id === assignment?.objectionId);
  const current = lifecycle.planObjections?.find(row => row.id === assignment?.objectionId);
  if (!assignment || !original || !current || current.state === "addressed" || current.responsibleParticipantId !== participantId ||
    original.responsibleParticipantId !== participantId || original.documentHash !== current.documentHash ||
    objectionTargetKey(original.target) !== objectionTargetKey(current.target)) return null;
  return { objectionId: current.id, attempt: current.attempts + 1 };
}

export async function previousCodexThread(collaborationId: string, agentId: string, beforeSequence: number) {
  const threadId = sql`JSON_UNQUOTE(JSON_EXTRACT(${connectorJobs.result}, '$.conversation.threadId'))`;
  // The legacy failure has no conversation metadata. Use the last native receipt
  // before it from this collaboration and Agent, without sorting large results.
  const previous = db.select({ sequence: max(connectorJobs.sequence) }).from(connectorJobs).where(and(
    eq(connectorJobs.collaborationId, collaborationId), eq(connectorJobs.agentId, agentId),
    eq(connectorJobs.kind, "collaboration.turn"), eq(connectorJobs.status, "completed"), lt(connectorJobs.sequence, beforeSequence),
    sql`JSON_UNQUOTE(JSON_EXTRACT(${connectorJobs.result}, '$.conversation.transport')) = 'codex-app-server'`,
    sql`JSON_TYPE(JSON_EXTRACT(${connectorJobs.result}, '$.conversation.threadId')) = 'STRING'`,
  ));
  const [receipt] = await db.select({ threadId }).from(connectorJobs).where(eq(connectorJobs.sequence, previous)).limit(1);
  const parsed = z.string().uuid().safeParse(receipt?.threadId);
  return parsed.success ? parsed.data : null;
}
