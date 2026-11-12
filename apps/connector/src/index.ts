import { createAgentAdapter, describeExecutionPolicy } from "@seam/agent-adapters";
import { createHash } from "node:crypto";
import { collaborationContextSchema } from "@seam/protocol";
import type { ConnectorConfig } from "./config.js";
import { ExecutionJournal, type JournalEntry } from "./journal.js";
import { withWorkspaceLock, workspaceBaseline } from "./workspace.js";
import { PlatformError, PlatformClient } from "./client.js";
import { createA2AHandler } from "./a2a.js";
import { CredentialStore } from "./credential-store.js";
import { assertOutboundPolicy } from "./outbound-policy.js";
import { runLocalTest } from "./local-test.js";

export async function runConnector(config: ConnectorConfig) {
  const adapter = createAgentAdapter(config.adapter, { codexSandbox: config.codexSandbox, appServerStateDir: config.appServerStateDir, codexNetworkAccess: config.codexNetworkAccess });
  const health = await adapter.healthCheck(config.projectRoot);
  if (!health.ok) throw new Error(`Agent 不可用：${health.detail}`);
  const client = new PlatformClient(config);
  const journal = new ExecutionJournal(config);
  let active: { id: string; attempts: number; controller: AbortController; leaseTimer: ReturnType<typeof setTimeout> } | undefined;
  const renewLocalLease = (expiresAt: string) => {
    if (!active) return;
    clearTimeout(active.leaseTimer);
    const controller = active.controller;
    active.leaseTimer = setTimeout(() => controller.abort(new Error("任务租约已过期，停止本地执行")), Math.max(0, Date.parse(expiresAt) - Date.now()));
    active.leaseTimer.unref();
  };
  const deliver = async (entry: JournalEntry) => {
    try {
      await client.complete(entry.jobId, entry.result, entry.error, entry.attempts);
      await journal.save({ ...entry, state: "acknowledged" });
    } catch (error) {
      if (error instanceof PlatformError && !error.retryable) await journal.save({ ...entry, state: "rejected", rejection: error.message });
      throw error;
    }
  };
  const credentialStore = new CredentialStore(config.agentId);
  const a2a = createA2AHandler(adapter, config.projectRoot, config.agentId, `${config.platformUrl}/api/a2a/${config.agentId}`);
  const capabilities = {
    adapter: config.adapter,
    executionMode: config.adapter === "codex" || config.adapter === "codex-app-server" ? config.codexSandbox ?? "read-only" : "external" as const,
    testConfigured: Boolean(process.env.SEAM_TEST_COMMAND),
  };
  await client.heartbeat(capabilities);
  let heartbeatPending = false;
  let heartbeatStopped = false;
  let heartbeatController: AbortController | undefined;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    heartbeatController = new AbortController();
    const observed = active;
    void client.heartbeat(capabilities, AbortSignal.any([heartbeatController.signal, AbortSignal.timeout(15_000)]), observed ? { id: observed.id, attempts: observed.attempts } : undefined).then((response) => {
      if (active !== observed || !observed) return;
      if (response.jobState?.cancelRequested) observed.controller.abort(new Error("平台已取消或暂停当前任务"));
      else if (response.jobState?.leaseUntil) renewLocalLease(response.jobState.leaseUntil);
    }).catch((error: unknown) => {
      if (!heartbeatStopped) console.error("Connector 心跳失败", error instanceof Error ? error.message : "中心暂不可达");
    }).finally(() => { heartbeatPending = false; });
  }, 20_000);
  heartbeatTimer.unref();
  console.log(`Seam Connector 已连接：${config.adapter}，项目目录 ${config.projectRoot}`);
  console.log(`本地执行策略：${describeExecutionPolicy(config.adapter, { codexSandbox: config.codexSandbox, codexNetworkAccess: config.codexNetworkAccess })}`);

  try {
  do {
    let phase = "领取任务";
    try {
      // Drain durable receipts before claiming any new local work.
      for (const entry of await journal.pending()) {
        try { await deliver(entry); } catch (error) {
          if (!(error instanceof PlatformError) || error.retryable) throw error;
          console.error(`Connector 提交任务 ${entry.jobId} 回执失败`, error.message);
        }
      }
      const job = await client.poll();
      if (!job) continue;
      const controller = new AbortController();
      active = { id: job.id, attempts: job.attempts, controller, leaseTimer: setTimeout(() => controller.abort(), 20 * 60 * 1000) };
      renewLocalLease(job.leaseUntil ?? new Date(Date.now() + 20 * 60 * 1000).toISOString());
      let result: Record<string, unknown> | undefined;
      let executionError: string | undefined;
      try {
        const cached = await journal.begin(job);
        if (cached) { result = cached.result; executionError = cached.error; }
        else await withWorkspaceLock(config.projectRoot, controller.signal, async () => {
          const before = await workspaceBaseline(config.projectRoot);
          const credentialIds = Array.isArray(job.payload.credentialIds) ? job.payload.credentialIds : [];
          for (const credentialId of credentialIds) {
            if (typeof credentialId !== "string" || await credentialStore.get(credentialId)) continue;
            const credential = await client.claimCredential(credentialId);
            await credentialStore.put(credentialId, credential.value);
          }
          if (job.kind === "collaboration.turn") {
            const context = collaborationContextSchema.parse(job.payload.context);
            const planned = context.lifecycle?.contributions.find((item) => item.participantId === context.participant.id)?.baseline;
            if (context.lifecycle?.phase === "executing" && planned && (!before || planned.head !== before.head || planned.treeHash !== before.treeHash)) {
              result = { agentTurn: { message: "工作区基线已变化或无法核对，已停止实施，请核对基线并重新批准。", actions: [{ type: "execution.report", revision: context.lifecycle.revision, status: "failed", summary: before ? "批准文档对应的代码基线已变化，未执行代码修改。" : "当前工作区基线无法读取，不能核对已批准版本，未执行代码修改。", evidence: { planned, current: before } }] } };
              return;
            }
            const input = { context, signal: controller.signal, projectRoot: config.projectRoot, jobPayloadHash: createHash("sha256").update(JSON.stringify(job.payload)).digest("hex") };
            const agentTurn = assertOutboundPolicy(await adapter.run(input), config.projectRoot);
            for (const action of agentTurn.actions) if (action.type === "plan.submit" && before) action.baseline = before;
            const conversation = await adapter.getConversation?.(input);
            result = { agentTurn, ...(conversation ? { conversation } : {}) };
          } else if (job.kind === "a2a.message") {
            const response = await a2a.transport.handle(job.payload.request);
            if (Symbol.asyncIterator in Object(response)) throw new Error("Connector 不支持流式 A2A 请求");
            result = { response };
          } else if (job.kind === "local.test") {
            result = { testRun: await runLocalTest(config.projectRoot, controller.signal) };
          } else {
            const agentTurn = assertOutboundPolicy(await adapter.run({ prompt: "检查当前项目健康状态，不要修改文件。", signal: controller.signal, projectRoot: config.projectRoot }), config.projectRoot);
            result = { agentTurn };
          }
          if (result) {
            const workspace = { before, after: await workspaceBaseline(config.projectRoot) };
            result.workspace = workspace;
            const turn = result.agentTurn as { actions?: import("@seam/protocol").AgentAction[] } | undefined;
            for (const action of turn?.actions ?? []) {
              if (action.type === "execution.report") action.evidence = { ...action.evidence, workspace };
              if (action.type === "integration.report") for (const check of action.checks) check.evidence = { ...check.evidence, workspace };
            }
          }
        }, config.workspaceLockDir);
      } catch (error) {
        executionError = error instanceof Error ? error.message : String(error);
      }
      // A rejected/lost completion is a delivery failure, not a second local
      // execution failure. Never send a contradictory second receipt.
      phase = `提交任务 ${job.id} 回执`;
      clearTimeout(active.leaseTimer);
      if (controller.signal.aborted) {
        try { await client.heartbeat(capabilities, AbortSignal.timeout(15_000), { id: job.id, attempts: job.attempts, cancelled: true }); } catch {}
      }
      active = undefined;
      const receipt: JournalEntry = { jobId: job.id, attempts: job.attempts, state: "pending", result, error: executionError, updatedAt: new Date().toISOString() };
      await journal.save(receipt);
      await deliver(receipt);
    } catch (error) {
      console.error(`Connector ${phase}失败`, error instanceof Error ? error.message : error);
      if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
    if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  } while (!config.once);
  } finally { if (active) { clearTimeout(active.leaseTimer); active.controller.abort(); } heartbeatStopped = true; clearInterval(heartbeatTimer); heartbeatController?.abort(); }
}

export { createA2AHandler } from "./a2a.js";
export { PlatformClient } from "./client.js";
export { CredentialStore } from "./credential-store.js";
export { assertOutboundPolicy } from "./outbound-policy.js";
export { readConfig } from "./config.js";
