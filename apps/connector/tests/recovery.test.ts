import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnector } from "../src/index";
import { readConfig } from "../src/config";
import { ExecutionJournal } from "../src/journal";
import { withWorkspaceLock, workspaceBaseline } from "../src/workspace";
import { MockAgentAdapter } from "@seam/agent-adapters";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "seam-recovery-")); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("本地执行与网络故障恢复", () => {
  it("服务端保存完成但 ACK 丢失，Connector 重启后只重发回执，不重复执行命令", async () => {
    await writeFile(join(root, "test.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync("runs.txt", "executed\\n");');
    vi.stubEnv("SEAM_TEST_COMMAND", "node test.mjs");
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "test-only", SEAM_PROJECT_ROOT: root });
    config.stateDir = join(root, "state"); config.workspaceLockDir = join(root, "locks");
    const job = { id: crypto.randomUUID(), agentId: config.agentId, collaborationId: null, kind: "local.test", payload: {}, attempts: 1 };
    let claimed = false, completions = 0;
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: any) => {
      if (url.endsWith("/poll")) { const next = claimed ? null : job; claimed = true; return new Response(JSON.stringify({ job: next })); }
      if (url.endsWith("/complete")) {
        completions++; bodies.push(JSON.parse(options.body));
        if (completions === 1) throw new Error("connection lost after server commit");
      }
      return new Response(JSON.stringify({ ok: true }));
    }));
    vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    await runConnector(config);
    const journal = new ExecutionJournal(config);
    expect(await journal.pending()).toHaveLength(1);
    await runConnector(config);
    expect(await readFile(join(root, "runs.txt"), "utf8")).toBe("executed\n");
    expect(completions).toBe(2); expect(bodies[1]).toEqual(bodies[0]);
    expect(await journal.pending()).toEqual([]);
    expect((await journal.read(job.id))!.state).toBe("acknowledged");
  });
  it("同一项目不同协作的写入串行，取消等待者不会释放另一个任务的锁", async () => {
    const locks = join(root, "locks");
    const events: string[] = [];
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = withWorkspaceLock(root, new AbortController().signal, async () => { events.push("first-start"); entered(); await new Promise<void>((resolve) => { release = resolve; }); events.push("first-end"); }, locks);
    await started;
    const cancelled = new AbortController();
    const second = withWorkspaceLock(root, cancelled.signal, async () => { events.push("should-not-run"); }, locks);
    const rejection = expect(second).rejects.toThrow("取消");
    cancelled.abort(); await rejection;
    expect(events).toEqual(["first-start"]);
    const third = withWorkspaceLock(root, new AbortController().signal, async () => { events.push("third"); }, locks);
    release(); await Promise.all([first, third]);
    expect(events).toEqual(["first-start", "first-end", "third"]);
    expect(await readdir(locks)).toEqual([]);
  });
  it("执行中断的未知结果保留记录并阻止盲目重跑", async () => {
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "test-only" });
    config.stateDir = root;
    const journal = new ExecutionJournal(config);
    const job = { id: crypto.randomUUID(), attempts: 1 } as any;
    await journal.begin(job);
    await expect(new ExecutionJournal(config).begin({ ...job, attempts: 2 })).rejects.toThrow("完成状态未知");
    expect((await journal.read(job.id))!.state).toBe("running");
  });
  it("非Git项目明确不提供Git基线，不伪造版本", async () => { expect(await workspaceBaseline(root)).toBeNull(); });
  it.each(["changed", "unavailable"])("已批准基线%s时，在调用Agent前停止实施并提交失败证据", async (condition) => {
    const project = join(root, "project"); await mkdir(project);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
    git("init", "--quiet"); await writeFile(join(project, "service.mjs"), "export const version = 1;\n");
    git("add", "service.mjs"); git("-c", "user.name=Seam Test", "-c", "user.email=test@seam.test", "commit", "--quiet", "-m", "fixture");
    const baseline = await workspaceBaseline(project); expect(baseline).not.toBeNull();
    if (condition === "changed") await writeFile(join(project, "service.mjs"), "export const version = 2;\n");
    else await rm(join(project, ".git"), { recursive: true, force: true });
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "test-only", SEAM_PROJECT_ROOT: project });
    config.stateDir = join(root, "state"); config.workspaceLockDir = join(root, "locks");
    const participantId = crypto.randomUUID(), collaborationId = crypto.randomUUID();
    const participant = { id: participantId, projectId: crypto.randomUUID(), projectName: "isolated baseline fixture", agentId: config.agentId, agentName: "fixture", role: "consumer", approvalRequired: true, status: "active" };
    const context = { collaborationId, title: "baseline guard", type: "custom", status: "in_progress", objective: "respect the approved code baseline", participant, participants: [participant], messages: [], artifacts: [], workItems: [], lifecycle: {
      revision: 1, phase: "executing", requirements: "approved fixture", document: "approved fixture document", documentHash: "a".repeat(64), approvedHash: "a".repeat(64), requiredParticipantIds: [participantId], contributions: [{ participantId, content: "approved analysis", baseline }], confirmations: [participantId], reports: [], report: null,
    } };
    const run = vi.spyOn(MockAgentAdapter.prototype, "run");
    const receipts: any[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: any) => {
      if (url.endsWith("/poll")) return new Response(JSON.stringify({ job: { id: crypto.randomUUID(), agentId: config.agentId, collaborationId, kind: "collaboration.turn", payload: { context }, attempts: 1 } }));
      if (url.endsWith("/complete")) receipts.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }));
    }));
    await runConnector(config);
    expect(run).not.toHaveBeenCalled(); expect(receipts).toHaveLength(1);
    expect(receipts[0].result.agentTurn.actions[0]).toMatchObject({ type: "execution.report", status: "failed", evidence: { planned: baseline, current: condition === "unavailable" ? null : expect.any(Object) } });
    expect(receipts[0].result.agentTurn.actions[0].summary).toContain(condition === "unavailable" ? "无法读取" : "已变化");
  });
  it("代码基线覆盖已跟踪、暂存与未跟踪文件内容变化", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "--quiet");
    await writeFile(join(root, "service.mjs"), "export const version = 1;\n");
    git("add", "service.mjs");
    git("-c", "user.name=Seam Test", "-c", "user.email=test@seam.test", "commit", "--quiet", "-m", "fixture");
    const initial = (await workspaceBaseline(root))!;
    await writeFile(join(root, "service.mjs"), "export const version = 2;\n");
    const changed = (await workspaceBaseline(root))!;
    expect(changed.head).toBe(initial.head); expect(changed.treeHash).not.toBe(initial.treeHash);
    git("add", "service.mjs");
    expect((await workspaceBaseline(root))!.treeHash).toBe(changed.treeHash);
    await writeFile(join(root, "new.mjs"), "new implementation\n");
    const added = (await workspaceBaseline(root))!;
    await writeFile(join(root, "new.mjs"), "changed untracked implementation\n");
    expect((await workspaceBaseline(root))!.treeHash).not.toBe(added.treeHash);
  });
});
