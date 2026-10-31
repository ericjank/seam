import { createAgentAdapter } from "@seam/agent-adapters";
import { collaborationContextSchema } from "@seam/protocol";
import type { ConnectorConfig } from "./config";
import { PlatformClient } from "./client";
import { createA2AHandler } from "./a2a";
import { CredentialStore } from "./credential-store";
import { assertOutboundPolicy } from "./outbound-policy";
import { runLocalTest } from "./local-test";

export async function runConnector(config: ConnectorConfig) {
  const adapter = createAgentAdapter(config.adapter);
  const health = await adapter.healthCheck(config.projectRoot);
  if (!health.ok) throw new Error(`Agent 不可用：${health.detail}`);
  const client = new PlatformClient(config);
  const credentialStore = new CredentialStore(config.agentId);
  const a2a = createA2AHandler(adapter, config.projectRoot, config.agentId, `${config.platformUrl}/api/a2a/${config.agentId}`);
  await client.heartbeat();
  console.log(`Seam Connector 已连接：${config.adapter}，项目目录 ${config.projectRoot}`);

  do {
    try {
      const job = await client.poll();
      if (!job) continue;
      try {
        const credentialIds = Array.isArray(job.payload.credentialIds) ? job.payload.credentialIds : [];
        for (const credentialId of credentialIds) {
          if (typeof credentialId !== "string" || await credentialStore.get(credentialId)) continue;
          const credential = await client.claimCredential(credentialId);
          await credentialStore.put(credentialId, credential.value);
        }
        if (job.kind === "collaboration.turn") {
          const context = collaborationContextSchema.parse(job.payload.context);
          const result = assertOutboundPolicy(await adapter.run({ context, projectRoot: config.projectRoot }), config.projectRoot);
          await client.complete(job.id, { agentTurn: result });
        } else if (job.kind === "a2a.message") {
          const response = await a2a.transport.handle(job.payload.request);
          if (Symbol.asyncIterator in Object(response)) throw new Error("Connector 不支持流式 A2A 请求");
          await client.complete(job.id, { response });
        } else if (job.kind === "local.test") {
          const result = await runLocalTest(config.projectRoot);
          await client.complete(job.id, { testRun: result });
        } else {
          const result = assertOutboundPolicy(await adapter.run({ prompt: "检查当前项目健康状态，不要修改文件。", projectRoot: config.projectRoot }), config.projectRoot);
          await client.complete(job.id, { agentTurn: result });
        }
      } catch (error) {
        await client.complete(job.id, undefined, error instanceof Error ? error.message : String(error));
      }
    } catch (error) {
      console.error("Connector 轮询失败", error instanceof Error ? error.message : error);
      if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
    if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  } while (!config.once);
}

export { createA2AHandler } from "./a2a";
export { PlatformClient } from "./client";
export { CredentialStore } from "./credential-store";
export { assertOutboundPolicy } from "./outbound-policy";
export { readConfig } from "./config";
