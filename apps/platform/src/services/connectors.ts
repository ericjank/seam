import { createHash } from "node:crypto";
import { gt, and, asc, desc, eq, lte, isNull, sql } from "drizzle-orm";
import { threadBusyReceiptSchema, type ConnectorResult } from "@seam/protocol";
import { db, withTransaction } from "@/db";
import { agents, collaborations, connectorJobs, connectorJobsClaimIndex, auditEvents } from "@/db/schema";
import { hashToken, newId } from "@/lib/ids";
import { HttpError } from "@/lib/http";
import { requireCollaborationAccess } from "@/lib/access";
import { audit } from "@/lib/audit";
import { completeAgentTurn, refreshAgentJobContext } from "./agent-engine";
import { submitAcceptance } from "./acceptance";
import { drainWorkflowWakeups, queueWorkflowWakeup } from "./workflow-outbox";
import { assertLifecycleJobCurrent, type LifecycleSnapshot } from "./lifecycle";
import { z, ZodError } from "zod";

const localTestResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  summary: z.string().min(1).max(20_000),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

async function advanceWithReceipt(jobId: string, collaborationId: string | null) {
  if (collaborationId) try { await drainWorkflowWakeups({ collaborationId }); } catch (error) { console.error("后续调度暂不可用，已保存待恢复记录", error); }
}

export async function authenticateConnector(request: Request, agentId: string) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "缺少 Connector 凭据");
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent || agent.tokenHash !== hashToken(authorization.slice(7))) throw new HttpError(401, "Connector 凭据无效");
  return agent;
}

export async function heartbeat(agentId: string, capabilities?: {
  adapter: "codex" | "codex-app-server" | "claude-code" | "generic-cli" | "mock";
  executionMode: "read-only" | "workspace-write" | "external";
  testConfigured: boolean;
  supportsInformationLookup?: boolean;
  protocolVersion?: number;
  build?: {kind:string;sourceId:string;files:number};
}, activeJob?: { id: string; attempts: number; cancelled?: boolean; recoveryKey?: string }) {
  await db.update(agents).set({ status: "online", lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agentId));
  if (capabilities) {
    const [latest] = await db.select({ metadata: auditEvents.metadata }).from(auditEvents).where(and(
      eq(auditEvents.actorId, agentId), eq(auditEvents.action, "connector.capabilities"),
    )).orderBy(desc(auditEvents.sequence)).limit(1);
    const previous = latest?.metadata as typeof capabilities | undefined;
    if (!previous || previous.adapter !== capabilities.adapter || previous.executionMode !== capabilities.executionMode || previous.testConfigured !== capabilities.testConfigured || previous.supportsInformationLookup !== capabilities.supportsInformationLookup || previous.protocolVersion !== capabilities.protocolVersion || previous.build?.sourceId !== capabilities.build?.sourceId) {
      await db.insert(auditEvents).values({ id: newId(), actorType: "connector", actorId: agentId, action: "connector.capabilities", metadata: capabilities });
    }
  }
  let jobState: { cancelRequested: boolean; leaseUntil?: string; cancellationAcknowledged?: boolean; receiptRejected?: boolean } | undefined;
  if (activeJob) {
    const [job] = await db.select().from(connectorJobs).where(and(eq(connectorJobs.id, activeJob.id), eq(connectorJobs.agentId, agentId))).limit(1);
    const current = job && job.attempts === activeJob.attempts;
    if (activeJob.cancelled && current && job.status === "cancelled" && !job.cancellationAckAt) await db.update(connectorJobs).set({ cancellationAckAt: new Date(), updatedAt: new Date() }).where(and(eq(connectorJobs.id, job.id), eq(connectorJobs.attempts, activeJob.attempts), isNull(connectorJobs.cancellationAckAt)));
    const valid = current && job.status === "running" && job.leaseUntil && job.leaseUntil.getTime() > Date.now();
    const recoveryKeyHash = activeJob.recoveryKey ? createHash("sha256").update(activeJob.recoveryKey).digest("hex") : null;
    if (valid && (!job.recoveryKeyHash || job.recoveryKeyHash === recoveryKeyHash)) {
      const leaseUntil = new Date(Date.now() + 20 * 60 * 1000);
      const [renewal] = await db.update(connectorJobs).set({ leaseUntil, ...(recoveryKeyHash ? {recoveryKeyHash} : {}), updatedAt: new Date() }).where(and(eq(connectorJobs.id, job.id), eq(connectorJobs.status, "running"), eq(connectorJobs.attempts, activeJob.attempts), gt(connectorJobs.leaseUntil, new Date())));
      jobState = renewal.affectedRows === 1 ? { cancelRequested: false, leaseUntil: leaseUntil.toISOString() } : { cancelRequested: true };
    } else jobState = { cancelRequested: true, ...(activeJob.cancelled ? current && job.status === "cancelled" ? { cancellationAcknowledged: true } : { receiptRejected: true } : {}) };
  }
  await drainWorkflowWakeups({ agentId });
  return jobState;
}

/** The caller holds the local workspace lock; secret proof fences the previous attempt. */
export async function recoverConnectorJob(agentId:string, jobId:string, attempts:number, recoveryKey:string) {
  const [candidate] = await db.select().from(connectorJobs).where(and(eq(connectorJobs.id,jobId),eq(connectorJobs.agentId,agentId))).limit(1);
  if (!candidate) throw new HttpError(404,"原执行任务不存在");
  return withTransaction(async()=>{
    if(candidate.collaborationId)await db.select().from(collaborations).where(eq(collaborations.id,candidate.collaborationId)).limit(1).for("update");
    const [job]=await db.select().from(connectorJobs).where(and(eq(connectorJobs.id,jobId),eq(connectorJobs.agentId,agentId))).limit(1).for("update");
    const proof=createHash("sha256").update(recoveryKey).digest("hex");
    if(!job?.recoveryKeyHash || job.recoveryKeyHash!==proof)throw new HttpError(403,"恢复凭据不匹配，不能接管执行");
    if(job.status!=="running"||job.attempts!==attempts)throw new HttpError(409,"原执行领取已变化，不得恢复旧轮次");
    const payload=await refreshAgentJobContext(job);
    const updated={...job,payload,attempts:attempts+1,leaseUntil:new Date(Date.now()+60_000),updatedAt:new Date()};
    await db.update(connectorJobs).set({payload,attempts:updated.attempts,leaseUntil:updated.leaseUntil,updatedAt:updated.updatedAt}).where(eq(connectorJobs.id,jobId));
    await db.insert(auditEvents).values({id:newId(),collaborationId:job.collaborationId,actorType:"connector",actorId:agentId,action:"connector.execution_recovery_claimed",metadata:{jobId,previousAttempt:attempts,attempts:updated.attempts}});
    return updated;
  });
}

export async function pollConnectorJob(agentId: string, waitMs: number, signal?: AbortSignal, supportsInformationLookup = false, protocolVersion = 1, supportsThreadBusy = false) {
  const informationOnly = (payload: unknown) => Boolean((payload as { context?: { informationTask?: unknown } } | null)?.context?.informationTask);
  if (signal?.aborted) return null;
  await heartbeat(agentId);
  await db.update(connectorJobs).set({ status: "pending", leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(connectorJobs.agentId, agentId), eq(connectorJobs.status, "running"), lte(connectorJobs.leaseUntil, new Date())));
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 20000);
  let skipped = 0;
  for (;;) {
    if (signal?.aborted) return null;
    // The available_at index can cause a filesort of the payload read by the JSON predicates.
    const [candidate] = await db.select({ id: connectorJobs.id, attempts: connectorJobs.attempts })
      .from(connectorJobs, { forceIndex: connectorJobsClaimIndex })
      // MySQL sets available_at when the job is enqueued. Use the same clock to decide when it is due.
      .where(and(eq(connectorJobs.agentId, agentId), eq(connectorJobs.status, "pending"), lte(connectorJobs.availableAt, sql`CURRENT_TIMESTAMP(3)`),
        sql`COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(${connectorJobs.payload}, '$.context.lifecycle.protocolVersion')) AS UNSIGNED), 1) <= ${protocolVersion}`,
        supportsInformationLookup ? undefined : sql`(JSON_EXTRACT(${connectorJobs.payload}, '$.context.informationTask') IS NULL OR JSON_TYPE(JSON_EXTRACT(${connectorJobs.payload}, '$.context.informationTask')) = 'NULL')`,
        supportsThreadBusy ? undefined : sql`JSON_EXTRACT(${connectorJobs.payload}, '$.resumeThreadId') IS NULL`))
      .orderBy(asc(connectorJobs.sequence)).limit(1);
    if (candidate) {
      if (signal?.aborted) return null;
      const attempts = candidate.attempts + 1;
      const [claim] = await db.update(connectorJobs).set({
        // Delivery is not execution. A disconnected receiver must not hold a
        // 20-minute execution lease without acknowledging the claimed attempt.
        status: "running", recoveryKeyHash: null, attempts, leaseUntil: new Date(Date.now() + 60_000), updatedAt: new Date(),
      }).where(and(eq(connectorJobs.id, candidate.id), eq(connectorJobs.status, "pending"), eq(connectorJobs.attempts, candidate.attempts)));
      // Only the worker whose compare-and-set won may execute the task.
      if (claim.affectedRows === 1) {
        const [claimed] = await db.select().from(connectorJobs)
          .where(and(eq(connectorJobs.id, candidate.id), eq(connectorJobs.status, "running"), eq(connectorJobs.attempts, attempts))).limit(1);
        if (claimed) {
          const release = () => db.update(connectorJobs).set({ status: "pending", leaseUntil: null, updatedAt: new Date() }).where(and(eq(connectorJobs.id, claimed.id), eq(connectorJobs.status, "running"), eq(connectorJobs.attempts, claimed.attempts)));
          try {
            if (signal?.aborted) { await release(); return null; }
            const payload = await refreshAgentJobContext(claimed);
            if (signal?.aborted) { await release(); return null; }
            await db.update(connectorJobs).set({ payload, updatedAt: new Date() }).where(and(
              eq(connectorJobs.id, claimed.id), eq(connectorJobs.status, "running"), eq(connectorJobs.attempts, claimed.attempts),
            ));
            // Old Connectors strip unknown context fields and could otherwise
            // execute normal approved work while assigned a read-only lookup.
            const minimum = (payload as { context?: { lifecycle?: { protocolVersion?: number } } })?.context?.lifecycle?.protocolVersion ?? 1;
            if ((!supportsInformationLookup && informationOnly(payload)) || minimum > protocolVersion) { await release(); if (++skipped < 20) continue; return null; }
            return { ...claimed, payload };
          } catch (error) {
            if (signal?.aborted) { await release(); return null; }
            const message = error instanceof HttpError ? error.message : "任务上下文准备失败，请检查项目参与方与协作状态";
            await db.update(connectorJobs).set({ status: "failed", error: message, leaseUntil: null, updatedAt: new Date() })
              .where(and(eq(connectorJobs.id, claimed.id), eq(connectorJobs.status, "running"), eq(connectorJobs.attempts, claimed.attempts)));
            if (!(error instanceof HttpError)) console.error("Agent 上下文刷新失败", error);
            if (claimed.collaborationId) await queueWorkflowWakeup(claimed.collaborationId, claimed.id);
            await advanceWithReceipt(claimed.id, claimed.collaborationId);
            throw new HttpError(error instanceof HttpError ? error.status : 409, message);
          }
        }
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 500); signal?.addEventListener("abort", done, { once: true }); if (signal?.aborted) done();
    });
  }
}

export async function retryThreadJob(userId: string, collaborationId: string, input: { jobId: string; attempts: number }) {
  return withTransaction(async () => {
    const { role } = await requireCollaborationAccess(userId, collaborationId, true);
    if (role !== "owner") throw new HttpError(403, "仅协作管理员可以重派等待会话释放的任务");
    const [collaboration] = await db.select({ id: collaborations.id }).from(collaborations).where(eq(collaborations.id, collaborationId)).limit(1).for("update");
    if (!collaboration) throw new HttpError(404, "协作不存在");
    const [job] = await db.select().from(connectorJobs).where(and(
      eq(connectorJobs.id, input.jobId), eq(connectorJobs.collaborationId, collaborationId), eq(connectorJobs.kind, "collaboration.turn"),
    )).limit(1).for("update");
    if (job?.status !== "waiting_thread" || job.attempts !== input.attempts) throw new HttpError(409, "等待会话释放的任务已变化，请刷新协作");
    const blocker = threadBusyReceiptSchema.parse((job.result as { threadBusy?: unknown } | null)?.threadBusy);
    const payload = await refreshAgentJobContext(job) as Record<string, unknown>;
    await db.update(connectorJobs).set({
      status: "pending", payload: { ...payload, resumeThreadId: blocker.threadId },
      receiptHash: null, result: null, leaseUntil: null, availableAt: sql`CURRENT_TIMESTAMP(3)`, updatedAt: new Date(),
    }).where(eq(connectorJobs.id, job.id));
    await audit({ collaborationId, actorType: "user", actorId: userId, action: "connector.thread_retry", metadata: { jobId: job.id, attempts: job.attempts, threadId: blocker.threadId } });
    return job.id;
  });
}

export async function completeConnectorJob(agentId: string, input: ConnectorResult) {
  const receiptHash = createHash("sha256").update(canonical(input.status === "waiting_thread"
    ? { status: input.status, threadBusy: input.threadBusy, attempts: input.attempts }
    : { status: input.status, result: input.result ?? null, error: input.error ?? null, attempts: input.attempts ?? null })).digest("hex");
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
    if (job?.status === "waiting_thread" && job.receiptHash === receiptHash) return;
    if (job && ["completed", "failed"].includes(job.status) && job.receiptHash === receiptHash) {
      if (job.status === "failed" && input.status === "completed") throw new HttpError(422, job.error ?? "动作已拒绝");
      advance = job.kind === "collaboration.turn";
      return;
    }
    if (!job || job.status !== "running" || !job.leaseUntil || job.leaseUntil.getTime() <= Date.now()) {
      throw new HttpError(409, "任务不存在、已完成或租约已失效");
    }
    if (input.attempts !== undefined ? input.attempts !== job.attempts : job.attempts > 1) {
      throw new HttpError(409, "任务已重新领取，请使用当前领取轮次回传结果");
    }
    if (input.status === "waiting_thread") {
      if (job.kind !== "collaboration.turn" || !job.collaborationId) throw new HttpError(422, "仅协作任务可等待会话释放");
      const payload = job.payload as { lifecycleSnapshot?: LifecycleSnapshot; resumeThreadId?: string };
      if (payload.resumeThreadId && input.threadBusy.threadId !== payload.resumeThreadId) throw new HttpError(422, "会话标识与原重派任务不符");
      await assertLifecycleJobCurrent(job.collaborationId, payload.lifecycleSnapshot);
      await db.update(connectorJobs).set({
        status: "waiting_thread", receiptHash, result: { threadBusy: input.threadBusy }, error: null,
        leaseUntil: null, recoveryKeyHash: null, updatedAt: new Date(),
      }).where(eq(connectorJobs.id, job.id));
      await audit({ collaborationId: job.collaborationId, actorType: "connector", actorId: agentId, action: "connector.thread_busy",
        metadata: { jobId: job.id, attempts: job.attempts, ...input.threadBusy } });
      return;
    }
    if (input.status === "failed") {
      await db.update(connectorJobs).set({
        status: "failed", receiptHash, result: null, error: input.error ?? "Connector 执行失败",
        leaseUntil: null, updatedAt: new Date(),
      }).where(eq(connectorJobs.id, input.jobId));
      advance = job.kind === "collaboration.turn";
      if (advance && job.collaborationId) await queueWorkflowWakeup(job.collaborationId, job.id);
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
          status: "completed", receiptHash, result: input.result ?? null, error: null, leaseUntil: null, updatedAt: new Date(),
        }).where(eq(connectorJobs.id, input.jobId));
      }, { savepoint: true });
      advance = job.kind === "collaboration.turn";
    } catch (error) {
      actionError = error instanceof HttpError ? error : new HttpError(422,
        error instanceof ZodError ? "Agent 返回结果格式不正确，本轮修改已回滚" : "Agent 动作应用失败，本轮修改已回滚");
      if (!(error instanceof HttpError) && !(error instanceof ZodError)) console.error("Agent 动作事务已回滚", error);
      await db.update(connectorJobs).set({
        status: "failed", receiptHash, result: null, error: (actionError as Error).message,
        leaseUntil: null, updatedAt: new Date(),
      }).where(eq(connectorJobs.id, input.jobId));
      advance = job.kind === "collaboration.turn";
    }
    if (advance && job.collaborationId) await queueWorkflowWakeup(job.collaborationId, job.id);
  });
  // Scheduling happens after the action transaction commits. A scheduling
  // failure must never cause a successfully applied turn to be replayed.
  if (advance) {
    await advanceWithReceipt(input.jobId, candidate.collaborationId);
  }
  if (actionError) throw actionError;
}
