import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import type { Message, Task, TaskState } from "@a2a-js/sdk";
import { db } from "@/db";
import { connectorJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { handleApiError } from "@/lib/http";
import { authenticateConnector } from "@/services/connectors";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await params;
    await authenticateConnector(request, agentId);
    const body = await request.json() as JsonRpcRequest;
    if (body.method === "message/send") return NextResponse.json(await sendMessage(agentId, body));
    if (body.method === "tasks/get") return NextResponse.json(await getTask(body));
    if (body.method === "tasks/cancel") return NextResponse.json(await cancelTask(body));
    return NextResponse.json(rpcError(body.id, -32601, "Method not found"));
  } catch (error) { return handleApiError(error); }
}

async function sendMessage(agentId: string, request: JsonRpcRequest) {
  const message = request.params?.message as Message | undefined;
  if (!message) return rpcError(request.id, -32602, "Missing message");
  const jobId = newId();
  await db.insert(connectorJobs).values({
    id: jobId, agentId, kind: "a2a.message", payload: { request },
  });
  const task: Task = {
    kind: "task", id: jobId, contextId: message.contextId ?? randomUUID(),
    status: { state: "submitted", timestamp: new Date().toISOString() }, history: [message],
  };
  return { jsonrpc: "2.0", id: request.id ?? null, result: task };
}

async function getTask(request: JsonRpcRequest) {
  const taskId = request.params?.id;
  if (typeof taskId !== "string") return rpcError(request.id, -32602, "Missing task id");
  const [job] = await db.select().from(connectorJobs).where(eq(connectorJobs.id, taskId)).limit(1);
  if (!job) return rpcError(request.id, -32001, "Task not found");
  return { jsonrpc: "2.0", id: request.id ?? null, result: mapJobToTask(job) };
}

async function cancelTask(request: JsonRpcRequest) {
  const taskId = request.params?.id;
  if (typeof taskId !== "string") return rpcError(request.id, -32602, "Missing task id");
  await db.update(connectorJobs).set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(connectorJobs.id, taskId), eq(connectorJobs.status, "pending")));
  const [job] = await db.select().from(connectorJobs).where(eq(connectorJobs.id, taskId)).limit(1);
  if (!job) return rpcError(request.id, -32001, "Task not found");
  return { jsonrpc: "2.0", id: request.id ?? null, result: mapJobToTask(job) };
}

function mapJobToTask(job: typeof connectorJobs.$inferSelect): Task {
  const state: TaskState = job.status === "completed" ? "completed"
    : job.status === "failed" ? "failed"
      : job.status === "cancelled" ? "canceled"
        : job.status === "running" ? "working" : "submitted";
  const request = (job.payload as { request?: JsonRpcRequest }).request;
  const originalMessage = request?.params?.message as Message | undefined;
  const history = originalMessage ? [originalMessage] : [];
  const response = (job.result as { response?: { result?: Message } } | null)?.response?.result;
  if (response?.kind === "message") history.push(response);
  return {
    kind: "task", id: job.id,
    contextId: originalMessage?.contextId ?? job.collaborationId ?? job.id,
    status: {
      state, timestamp: job.updatedAt.toISOString(),
      message: job.error ? { kind: "message", messageId: newId(), role: "agent", parts: [{ kind: "text", text: job.error }] } : undefined,
    },
    history,
  };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
