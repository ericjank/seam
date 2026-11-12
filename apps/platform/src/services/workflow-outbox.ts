import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { collaborationLifecycles, collaborations, participants, workflowWakeups } from "@/db/schema";
import { newId } from "@/lib/ids";

export async function queueWorkflowWakeup(collaborationId: string, sourceJobId?: string) {
  const [control] = await db.select().from(collaborationLifecycles).where(eq(collaborationLifecycles.collaborationId, collaborationId)).limit(1);
  await db.insert(workflowWakeups).values({ id: newId(), collaborationId, sourceJobId: sourceJobId ?? null,
    snapshot: control ? { revision: control.revision, phase: control.phase, documentHash: control.documentHash } : null });
}

export async function drainWorkflowWakeups(scope: { agentId?: string; collaborationId?: string }) {
  // Event processing may be concurrent: dispatch and advancement lock the
  // collaboration and coalesce existing jobs, making replay safe.
  const eligible = scope.agentId ? await db.select({ collaborationId: participants.collaborationId }).from(participants)
    .where(and(eq(participants.agentId, scope.agentId), eq(participants.status, "active"))) : null;
  if (eligible && !eligible.length) return;
  const rows = await db.select().from(workflowWakeups).where(and(isNull(workflowWakeups.completedAt), lte(workflowWakeups.availableAt, new Date()),
    scope.collaborationId ? eq(workflowWakeups.collaborationId, scope.collaborationId) : undefined,
    eligible ? inArray(workflowWakeups.collaborationId, eligible.map((entry) => entry.collaborationId)) : undefined)).orderBy(asc(workflowWakeups.availableAt)).limit(100);
  for (const row of rows.filter((item) => !eligible || eligible.some((entry) => entry.collaborationId === item.collaborationId)).slice(0, 20)) {
    try {
      const { advanceAgentWorkflow, dispatchAgentTurns } = await import("./agent-engine");
      const [control] = await db.select().from(collaborationLifecycles).where(eq(collaborationLifecycles.collaborationId, row.collaborationId)).limit(1);
      const stale = row.snapshot && (!control || row.snapshot.revision !== control.revision);
      if (!stale && !control?.pausedAt) {
        if (row.sourceJobId) await advanceAgentWorkflow(row.sourceJobId);
        else if (control && row.snapshot?.phase === control.phase && row.snapshot.documentHash === control.documentHash && ["planning", "plan_synthesis", "plan_confirmation", "executing", "joint_verifying"].includes(control.phase)) {
          const [collaboration] = await db.select().from(collaborations).where(eq(collaborations.id, row.collaborationId)).limit(1);
          if (collaboration) await dispatchAgentTurns(collaboration.createdById, row.collaborationId, undefined, { autoAdvance: true });
        }
      }
      await db.update(workflowWakeups).set({ completedAt: new Date(), error: null, updatedAt: new Date() }).where(eq(workflowWakeups.id, row.id));
    } catch (error) {
      await db.update(workflowWakeups).set({ attempts: row.attempts + 1, error: error instanceof Error ? error.message : "调度失败",
        availableAt: new Date(Date.now() + Math.min(120_000, 1000 * 2 ** Math.min(row.attempts, 7))), updatedAt: new Date() }).where(eq(workflowWakeups.id, row.id));
    }
  }
}
