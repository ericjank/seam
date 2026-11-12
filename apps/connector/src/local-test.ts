import { exec } from "node:child_process";
import { sanitizeOutput } from "./evidence.js";

export async function runLocalTest(projectRoot: string, signal?: AbortSignal, extraEnv: Record<string, string> = {}, onResult?: (record: { id: string; command: string; exitCode: number; output: string }) => void) {
  const command = process.env.SEAM_TEST_COMMAND;
  if (!command) throw new Error("未配置 SEAM_TEST_COMMAND，平台不会接受远程下发的任意命令");
  const startedAt = Date.now();
  const env = { ...process.env, ...extraEnv };
  delete env.SEAM_AGENT_TOKEN;
  const result = await new Promise<{ code: number; output: string }>((resolve) => {
    exec(command, { cwd: projectRoot, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024, env, signal }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === "number" ? error.code : error ? 1 : 0, output: `${stdout}\n${stderr}` });
    });
  });
  onResult?.({ id: `local-${startedAt}`, command, exitCode: result.code, output: result.output });
  return {
    status: result.code === 0 ? "passed" as const : "failed" as const,
    summary: result.code === 0 ? "Connector 本地测试命令执行通过" : `Connector 本地测试命令失败，退出码 ${result.code}`,
    evidence: {
      exitCode: result.code,
      durationMs: Date.now() - startedAt,
      outputTail: sanitizeOutput(result.output, projectRoot).slice(-4000),
    },
  };
}
