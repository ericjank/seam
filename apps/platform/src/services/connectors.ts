import { and, asc, eq, lte } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { agents, collaborations, connectorJobs, auditEvents } from "@/db/schema";
import { hashToken, newId } from "@/lib/ids";
import { HttpError } from "@/lib/http";
import { advanceAgentWorkflow, completeAgentTurn, refreshAgentJobContext } from "./agent-engine";
import { submitAcceptance } from "./acceptance";
import { addSystemMessage } from "./collaborations";
import { z, ZodError } from "zod";

const localTestResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  summary: z.string().min(1).max(20_000),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

async function advanceWithReceipt(jobId: string, collaborationId: string | null) {
  try { await advanceAgentWorkflow(jobId); }
  catch (error) {
    console.error("Agent 后续协作派发失败", error);
    if (collaborationId) {
      try { await addSystemMessage(collaborationId, "本轮执行结果已保存，但后续协作暂未派发。请点击继续推进重试。"); }
      catch (receiptError) { console.error("Agent 调度失败提示写入失败", receiptError); }
    }
  }
}

export async function authenticateConnector(request: Request, agentId: string) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "缺少 Connector 凭据");
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent || agent.tokenHash !== hashToken(authorization.slice(7))) throw new HttpError(401, "Connector 凭据无效");
  return agent;
}

export async function heartbeat(agentId: string, capabilities?: {
  adapter: "codex" | "claude-code" | "generic-cli" | "mock";
  executionMode: "read-only" | "workspace-write" | "external";
  testConfigured: boolean;
}) {
  await db.update(agents).set({ status: "online", lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agentId));
  if (capabilities) await db.insert(auditEvents).values({
    id: newId(), actorType: "connector", actorId: agentId, action: "connector.capabilities", metadata: capabilities,
  });
}

export async function pollConnectorJob(agentId: string, waitMs: number) {
  await heartbeat(agentId);
  await db.update(connectorJobs).set({ status: "pending", leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(connectorJobs.agentId, agentId), eq(connectorJobs.status, "running"), lte(connectorJobs.leaseUntil, new Date())));
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 20000);
  do {
    const [job] = await db.select().from(connectorJobs)
      .where(and(eq(connectorJobs.agentId, agentId), eq(connectorJobs.status, "pending"), lte(connectorJobs.availableAt, new Date())))
      .orderBy(asc(connectorJobs.sequence)).limit(1);
    if (job) {
      const [claim] = await db.update(connectorJobs).set({
        status: "running", attempts: job.attempts + 1, leaseUntil: new Date(Date.now() + 20 * 60 * 1000), updatedAt: new Date(),
      }).where(and(eq(connectorJobs.id, job.id), eq(connectorJobs.status, "pending"), eq(connectorJobs.attempts, job.attempts)));
      // Only the worker whose compare-and-set won may execute the task.
      if (claim.affectedRows === 1) {
        const [claimed] = await db.select().from(connectorJobs)
          .where(and(eq(connectorJobs.id, job.id), eq(connectorJobs.status, "running"), eq(connectorJobs.attempts, job.attempts + 1))).limit(1);
        if (claimed) {
          try {
            const payload = await refreshAgentJobContext(claimed);
            await db.update(connectorJobs).set({ payload, updatedAt: new Date() }).where(and(
              eq(connectorJobs.id, claimed.id), eq(connectorJobs.status, "running"), eq(connectorJobs.attempts, claimed.attempts),
            ));
            return { ...claimed, payload };
          } catch (error) {
            const message = error instanceof HttpError ? error.message : "任务上下文准备失败，请检查项目参与方与协作状态";
            await db.update(connectorJobs).set({ status: "failed", error: message, leaseUntil: null, updatedAt: new Date() })
              .where(and(eq(connectorJobs.id, claimed.id), eq(connectorJobs.status, "running"), eq(connectorJobs.attempts, claimed.attempts)));
            if (!(error instanceof HttpError)) console.error("Agent 上下文刷新失败", error);
            await advanceWithReceipt(claimed.id, claimed.collaborationId);
            throw new HttpError(error instanceof HttpError ? error.status : 409, message);
          }
        }
      }
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return null;
}

export async function completeConnectorJob(agentId: string, input: {
  jobId: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  attempts?: number;
}) {
  let actionError: unknown;
  let advance = false;
  const [candidate] = await db.select().from(connectorJobs)
    .where(and(eq(connectorJobs.id, input.jobId), eq(connectorJobs.agentId, agentId))).limit(1);
  if (!candidate) throw new HttpError(409, "任务不存在、已完成或租约已失效");
  await withTransaction(async () => {
    // Dispatch, completion and advancement acquire the collaboration first.
    // Serializing the whole collaboration also prevents artifact version races.
    if (candidate.collaborationId) await db.select().from(collaborations)
      .where(eq(collaborations.id, candidate.collaborationId)).limit(1).for("update");
    const [job] = await db.select().from(connectorJobs)
      .where(and(eq(connectorJobs.id, input.jobId), eq(connectorJobs.agentId, agentId))).limit(1).for("update");
    if (!job || job.status !== "running" || !job.leaseUntil || job.leaseUntil.getTime() <= Date.now()) {
      throw new HttpError(409, "任务不存在、已完成或租约已失效");
    }
    if (input.attempts !== undefined ? input.attempts !== job.attempts : job.attempts > 1) {
      throw new HttpError(409, "任务已重新领取，请使用当前领取轮次回传结果");
    }
    if (input.status === "failed") {
      await db.update(connectorJobs).set({
        status: "failed", result: null, error: input.error ?? "Connector 执行失败",
        leaseUntil: null, updatedAt: new Date(),
      }).where(eq(connectorJobs.id, input.jobId));
      advance = job.kind === "collaboration.turn";
      return;
    }

    try {
      // A rejected action rolls back the complete action batch while retaining
      // the outer row lock until the durable failure receipt has been written.
      await withTransaction(async () => {
        if (job.kind === "collaboration.turn") {
          await completeAgentTurn(input.jobId, input.result);
        } else if (job.kind === "local.test" && job.collaborationId) {
          const payload = z.object({
            participantId: z.string().uuid(),
            workItemId: z.string().uuid().nullish().transform((value) => value ?? undefined),
            artifactId: z.string().uuid().nullish().transform((value) => value ?? undefined),
          }).parse(job.payload);
          const testRun = localTestResultSchema.parse(input.result?.testRun);
          await submitAcceptance({ kind: "participant", id: payload.participantId }, job.collaborationId, {
            workItemId: payload.workItemId, artifactId: payload.artifactId,
            status: testRun.status, summary: testRun.summary, evidence: testRun.evidence,
          });
        }
        await db.update(connectorJobs).set({
          status: "completed", result: input.result ?? null, error: null, leaseUntil: null, updatedAt: new Date(),
        }).where(eq(connectorJobs.id, input.jobId));
      }, { savepoint: true });
      advance = job.kind === "collaboration.turn";
    } catch (error) {
      actionError = error instanceof HttpError ? error : new HttpError(422,
        error instanceof ZodError ? "Agent 返回结果格式不正确，本轮修改已回滚" : "Agent 动作应用失败，本轮修改已回滚");
      if (!(error instanceof HttpError) && !(error instanceof ZodError)) console.error("Agent 动作事务已回滚", error);
      await db.update(connectorJobs).set({
        status: "failed", result: null, error: (actionError as Error).message,
        leaseUntil: null, updatedAt: new Date(),
      }).where(eq(connectorJobs.id, input.jobId));
      advance = job.kind === "collaboration.turn";
    }
  });
  // Scheduling happens after the action transaction commits. A scheduling
  // failure must never cause a successfully applied turn to be replayed.
  if (advance) {
    await advanceWithReceipt(input.jobId, candidate.collaborationId);
  }
  if (actionError) throw actionError;
}
