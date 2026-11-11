import { createAgentAdapter, describeExecutionPolicy } from "@seam/agent-adapters";
import { collaborationContextSchema } from "@seam/protocol";
import type { ConnectorConfig } from "./config.js";
import { PlatformClient } from "./client.js";
import { createA2AHandler } from "./a2a.js";
import { CredentialStore } from "./credential-store.js";
import { assertOutboundPolicy } from "./outbound-policy.js";
import { runLocalTest } from "./local-test.js";

export async function runConnector(config: ConnectorConfig) {
  const adapter = createAgentAdapter(config.adapter, { codexSandbox: config.codexSandbox });
  const health = await adapter.healthCheck(config.projectRoot);
  if (!health.ok) throw new Error(`Agent 不可用：${health.detail}`);
  const client = new PlatformClient(config);
  const credentialStore = new CredentialStore(config.agentId);
  const a2a = createA2AHandler(adapter, config.projectRoot, config.agentId, `${config.platformUrl}/api/a2a/${config.agentId}`);
  await client.heartbeat({
    adapter: config.adapter,
    executionMode: config.adapter === "codex" ? config.codexSandbox ?? "read-only" : "external",
    testConfigured: Boolean(process.env.SEAM_TEST_COMMAND),
  });
  console.log(`Seam Connector 已连接：${config.adapter}，项目目录 ${config.projectRoot}`);
  console.log(`本地执行策略：${describeExecutionPolicy(config.adapter, { codexSandbox: config.codexSandbox })}`);

  do {
    let phase = "领取任务";
    try {
      const job = await client.poll();
      if (!job) continue;
      let result: Record<string, unknown> | undefined;
      let executionError: string | undefined;
      try {
        const credentialIds = Array.isArray(job.payload.credentialIds) ? job.payload.credentialIds : [];
        for (const credentialId of credentialIds) {
          if (typeof credentialId !== "string" || await credentialStore.get(credentialId)) continue;
          const credential = await client.claimCredential(credentialId);
          await credentialStore.put(credentialId, credential.value);
        }
        if (job.kind === "collaboration.turn") {
          const context = collaborationContextSchema.parse(job.payload.context);
          const agentTurn = assertOutboundPolicy(await adapter.run({ context, projectRoot: config.projectRoot }), config.projectRoot);
          result = { agentTurn };
        } else if (job.kind === "a2a.message") {
          const response = await a2a.transport.handle(job.payload.request);
          if (Symbol.asyncIterator in Object(response)) throw new Error("Connector 不支持流式 A2A 请求");
          result = { response };
        } else if (job.kind === "local.test") {
          result = { testRun: await runLocalTest(config.projectRoot) };
        } else {
          const agentTurn = assertOutboundPolicy(await adapter.run({ prompt: "检查当前项目健康状态，不要修改文件。", projectRoot: config.projectRoot }), config.projectRoot);
          result = { agentTurn };
        }
      } catch (error) {
        executionError = error instanceof Error ? error.message : String(error);
      }
      // A rejected/lost completion is a delivery failure, not a second local
      // execution failure. Never send a contradictory second receipt.
      phase = `提交任务 ${job.id} 回执`;
      await client.complete(job.id, result, executionError);
    } catch (error) {
      console.error(`Connector ${phase}失败`, error instanceof Error ? error.message : error);
      if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
    if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  } while (!config.once);
}

export { createA2AHandler } from "./a2a.js";
export { PlatformClient } from "./client.js";
export { CredentialStore } from "./credential-store.js";
export { assertOutboundPolicy } from "./outbound-policy.js";
export { readConfig } from "./config.js";
