import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { agents, connectorJobs } from "@/db/schema";
import { hashToken } from "@/lib/ids";
import { HttpError } from "@/lib/http";
import { completeAgentTurn } from "./agent-engine";
import { submitAcceptance } from "./acceptance";

export async function authenticateConnector(request: Request, agentId: string) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "缺少 Connector 凭据");
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent || agent.tokenHash !== hashToken(authorization.slice(7))) throw new HttpError(401, "Connector 凭据无效");
  return agent;
}

export async function heartbeat(agentId: string) {
  await db.update(agents).set({ status: "online", lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agentId));
}

export async function pollConnectorJob(agentId: string, waitMs: number) {
  await heartbeat(agentId);
  await db.update(connectorJobs).set({ status: "pending", leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(connectorJobs.agentId, agentId), eq(connectorJobs.status, "running"), lte(connectorJobs.leaseUntil, new Date())));
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 20000);
  do {
    const [job] = await db.select().from(connectorJobs)
      .where(and(eq(connectorJobs.agentId, agentId), eq(connectorJobs.status, "pending"), lte(connectorJobs.availableAt, new Date())))
      .orderBy(asc(connectorJobs.createdAt)).limit(1);
    if (job) {
      await db.update(connectorJobs).set({
        status: "running", attempts: job.attempts + 1, leaseUntil: new Date(Date.now() + 10 * 60 * 1000), updatedAt: new Date(),
      }).where(and(eq(connectorJobs.id, job.id), eq(connectorJobs.status, "pending")));
      const [claimed] = await db.select().from(connectorJobs)
        .where(and(eq(connectorJobs.id, job.id), eq(connectorJobs.status, "running"))).limit(1);
      if (claimed) return claimed;
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
}) {
  const [job] = await db.select().from(connectorJobs)
    .where(and(eq(connectorJobs.id, input.jobId), eq(connectorJobs.agentId, agentId))).limit(1);
  if (!job || job.status !== "running") throw new HttpError(409, "任务不存在、已完成或租约已失效");
  await db.update(connectorJobs).set({
    status: input.status, result: input.result ?? null, error: input.error ?? null,
    leaseUntil: null, updatedAt: new Date(),
  }).where(eq(connectorJobs.id, input.jobId));
  if (input.status === "completed" && job.kind === "collaboration.turn") {
    await completeAgentTurn(input.jobId, input.result);
  } else if (input.status === "completed" && job.kind === "local.test" && job.collaborationId) {
    const payload = job.payload as { participantId: string; workItemId?: string; artifactId?: string };
    const testRun = input.result?.testRun as { status: "passed" | "failed"; summary: string; evidence: Record<string, unknown> } | undefined;
    if (!testRun) throw new HttpError(422, "本地测试返回格式不正确");
    await submitAcceptance({ kind: "participant", id: payload.participantId }, job.collaborationId, {
      workItemId: payload.workItemId, artifactId: payload.artifactId,
      status: testRun.status, summary: testRun.summary, evidence: testRun.evidence,
    });
  }
}
