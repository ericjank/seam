import { stat } from "node:fs/promises";
import { createAgentAdapter, describeExecutionPolicy } from "@seam/agent-adapters";
import type { ConnectorConfig } from "./config.js";

/** Read-only diagnostics: no AI turn, heartbeat, credential claim or test run. */
export async function diagnoseConnector(config: ConnectorConfig) {
  let project = { ok: false, detail: "项目目录不存在或不可访问" };
  try {
    if ((await stat(config.projectRoot)).isDirectory()) project = { ok: true, detail: "项目目录可访问" };
  } catch { /* Deliberately avoid leaking raw filesystem errors or credentials. */ }
  const cli = project.ok
    ? await createAgentAdapter(config.adapter, { codexSandbox: config.codexSandbox, appServerStateDir: config.appServerStateDir, codexNetworkAccess: config.codexNetworkAccess }).healthCheck(config.projectRoot)
    : { ok: false, detail: "先配置有效项目目录" };
  const configured = Boolean(config.agentId && config.token);
  return {
    ok: project.ok && cli.ok,
    nodeVersion: process.versions.node,
    adapter: config.adapter,
    project,
    cli,
    executionPolicy: describeExecutionPolicy(config.adapter, { codexSandbox: config.codexSandbox, codexNetworkAccess: config.codexNetworkAccess }),
    executionNetworkConfigured: config.codexNetworkAccess === true,
    localTestConfigured: Boolean(process.env.SEAM_TEST_COMMAND),
    platformCredentialsConfigured: configured,
    note: "仅检查本地配置和 CLI 版本，未验证登录、实际写入、中心连通性或业务联调；不需要提交源码和凭据。",
  };
}
