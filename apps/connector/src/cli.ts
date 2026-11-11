#!/usr/bin/env node
import { readConfig } from "./config.js";
import { runConnector } from "./index.js";
import { diagnoseConnector } from "./doctor.js";

try {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Seam Connector 需要 Node.js 22+；请先选择已安装的新版 Node.js。");
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`Seam Connector
  node --env-file=/path/to/private/connector.env apps/connector/dist/cli.js
  --doctor                 本地诊断，无需中心凭据，不调用 AI
  --adapter codex-app-server  推荐：按协作保持本机 Codex 持久会话
  --adapter codex          兼容：每轮独立调用 codex exec
  --app-server-state-dir <path>  本机私有会话映射目录（默认 ~/.seam/threads）
  --project-root <path>    本项目目录
  --codex-sandbox <mode>   read-only（默认）或 workspace-write（本机明确授权后选择）
  --codex-network-access <true|false>  本地网络能力（默认false，仅批准的executing生效）
  --once                   处理至多一个中心任务后退出
  --platform <url> --agent-id <id> --token <token>  建议改用私有 env 文件配置`);
  } else {
    const config = readConfig(args);
    if (config.doctor) {
      const report = await diagnoseConnector(config);
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    } else await runConnector(config);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
