import { exec } from "node:child_process";

export async function runLocalTest(projectRoot: string) {
  const command = process.env.SEAM_TEST_COMMAND;
  if (!command) throw new Error("未配置 SEAM_TEST_COMMAND，平台不会接受远程下发的任意命令");
  const startedAt = Date.now();
  const env = { ...process.env };
  delete env.SEAM_AGENT_TOKEN;
  const result = await new Promise<{ code: number; output: string }>((resolve) => {
    exec(command, { cwd: projectRoot, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === "number" ? error.code : error ? 1 : 0, output: `${stdout}\n${stderr}` });
    });
  });
  return {
    status: result.code === 0 ? "passed" as const : "failed" as const,
    summary: result.code === 0 ? "Connector 本地测试命令执行通过" : `Connector 本地测试命令失败，退出码 ${result.code}`,
    evidence: {
      exitCode: result.code,
      durationMs: Date.now() - startedAt,
      outputTail: sanitizeOutput(result.output).slice(-4000),
    },
  };
}

function sanitizeOutput(output: string) {
  return output
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[已隐藏私钥]")
    .replace(/(?:DATABASE_URL|DB_PASSWORD|SECRET_ACCESS_KEY)\s*=\s*\S+/gi, "[已隐藏系统密钥]")
    .replace(/(mysql|postgres(?:ql)?):\/\/[^\s/]+:[^\s/]+@[^\s]+/gi, "[已隐藏连接串]");
}
