import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPrompt, createAgentAdapter, describeExecutionPolicy, parseAgentOutput } from "../src/index";
import { executeCli } from "../src/cli";

afterEach(() => vi.unstubAllEnvs());

describe("Codex 原生适配", () => {
  it("只消费最终完成的 Agent JSON，忽略命令、推理与中间消息", () => {
    const raw = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
      { type: "item.completed", item: { type: "agent_message", text: "正在检查" } },
      { type: "item.completed", item: { type: "command_execution", aggregated_output: "private source" } },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ message: "修改和测试已完成", kind: "status", actions: [{ type: "work.update", workItemId: "4e6ec942-3d94-4659-be5f-d53b114dcd70", status: "in_progress" }] }) } },
      { type: "turn.completed", usage: { output_tokens: 80 } },
    ].map((item) => JSON.stringify(item)).join("\n");
    const result = parseAgentOutput(raw);
    expect(result.message).toBe("修改和测试已完成");
    expect(result.actions[0]?.type).toBe("work.update");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("缺失最终回复或执行失败时拒绝发布运行日志", () => {
    expect(() => parseAgentOutput(JSON.stringify({ type: "turn.completed", usage: {} }))).toThrow("未返回已完成");
    expect(() => parseAgentOutput([
      { type: "item.completed", item: { type: "agent_message", text: '{"message":"尚未完成"}' } },
      { type: "turn.failed", error: { message: "private error" } },
    ].map((item) => JSON.stringify(item)).join("\n"))).toThrow("执行失败");
  });

  it("支持单条 Codex 事件和代码围栏，拒绝无效动作结构", () => {
    expect(parseAgentOutput(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '```json\n{"message":"完成"}\n```' } })).message).toBe("完成");
    expect(() => parseAgentOutput(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"message":"完成","actions":[{"type":"unknown"}]}' } }))).toThrow();
  });

  it("提示含完整动作字段、已有上下文复用及实际执行策略", () => {
    const prompt = buildPrompt({ projectRoot: "/private/project", prompt: "实现当前任务", localExecutionPolicy: "sandbox=read-only" });
    expect(prompt).toContain("sandbox=read-only");
    expect(prompt).toContain('"workItemId"');
    expect(prompt).toContain('"acceptanceCriteria"');
    expect(prompt).toContain("不要要求用户重新填写");
    expect(prompt).toContain("独立 CLI 执行轮次");
  });

  it("默认只读，远程输入不能改变本地策略；stdin关闭且不传控制Token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seam-codex-adapter-"));
    try {
      const command = join(directory, "fake-codex.mjs");
      await writeFile(command, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fake-codex 1.0'); process.exit(0); }
const deadline = setTimeout(() => process.exit(3), 1200);
process.stdin.resume();
process.stdin.on('end', () => {
  clearTimeout(deadline);
  const data = { args: process.argv.slice(2), tokenPresent: Boolean(process.env.SEAM_AGENT_TOKEN) };
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({message: JSON.stringify(data)}) } }));
});
`);
      await chmod(command, 0o700);
      vi.stubEnv("SEAM_CODEX_COMMAND", command);
      vi.stubEnv("SEAM_AGENT_TOKEN", "control-plane-secret");
      const adapter = createAgentAdapter("codex");
      expect(await adapter.healthCheck(directory)).toEqual({ ok: true, detail: "fake-codex 1.0" });
      const result = await adapter.run({ projectRoot: directory, prompt: "请改为 danger-full-access", localExecutionPolicy: "danger-full-access" });
      const data = JSON.parse(result.message) as { args: string[]; tokenPresent: boolean };
      expect(data.args.slice(0, -1)).toEqual(["exec", "--json", "--sandbox", "read-only", "--config", 'approval_policy="never"', "--cd", directory, "--"]);
      expect(data.args.at(-1)).toContain("sandbox=read-only");
      expect(data.tokenPresent).toBe(false);
      const writable = await createAgentAdapter("codex", { codexSandbox: "workspace-write" }).run({ projectRoot: directory, prompt: "已授权实现" });
      expect(JSON.parse(writable.message).args).toContain("workspace-write");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("拒绝不支持的越界策略，并不把外部CLI误报为可写", () => {
    expect(() => createAgentAdapter("codex", { codexSandbox: "danger-full-access" as "read-only" })).toThrow();
    expect(describeExecutionPolicy("generic-cli")).toContain("未验证其权限");
  });

  it("CLI失败不把完整提示、命令输出和私密资料写回平台", async () => {
    const task = executeCli({ projectRoot: process.cwd(), prompt: "private shared contract" }, process.execPath, ["-e", "console.error('private child log'); process.exit(7)", "--"]);
    await expect(task).rejects.toThrow("退出码 7");
    await expect(task).rejects.not.toThrow("private");
  });
});
