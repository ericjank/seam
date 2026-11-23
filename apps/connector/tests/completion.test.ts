import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnector } from "../src/index";
import { readConfig } from "../src/config";
import { MockAgentAdapter } from "@seam/agent-adapters";
import { CONNECTOR_PROTOCOL_VERSION, PLAN_OBJECTION_PROTOCOL_VERSION, agentTurnResultSchema } from "@seam/protocol";

let stateRoot: string;
beforeEach(async () => { stateRoot = await mkdtemp(join(tmpdir(), "seam-connector-test-")); });
afterEach(async () => { await rm(stateRoot, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Connector 回执交付", () => {
  it.each([PLAN_OBJECTION_PROTOCOL_VERSION, CONNECTOR_PROTOCOL_VERSION])("协议 %s 规划按协作容量提交或返回可恢复阻塞", async (protocolVersion) => {
    const root = join(stateRoot, "project");
    await mkdir(join(root, "tests"), { recursive: true });
    await mkdir(join(root, "reference/tests"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "/reference/\n");
    await symlink("../../tests/case-0.json", join(root, "reference/tests/cordis.yml"));
    await Promise.all(Array.from({ length: 508 }, (_, index) => writeFile(join(root, "tests", `case-${index}.json`), "{}")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "--quiet");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@seam.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "fixture-only", SEAM_PROJECT_ROOT: root });
    config.stateDir = join(stateRoot, "journal");
    config.workspaceLockDir = join(stateRoot, "locks");
    const id = crypto.randomUUID();
    const collaborationId = crypto.randomUUID();
    const context = {
      collaborationId, title: "指纹回归", type: "custom", status: "negotiating", objective: "核对测试基线",
      participant: { id, projectId: crypto.randomUUID(), projectName: "fixture", agentId: config.agentId, agentName: "fixture", role: "consumer", approvalRequired: true, status: "active" },
      participants: [], messages: [], artifacts: [], workItems: [],
      lifecycle: { phase: "planning", revision: 1, protocolVersion, requirements: "只读规划", document: null, documentHash: null,
        approvedHash: null, requiredParticipantIds: [id], contributions: [], confirmations: [], reports: [], report: null },
    };
    const turn = agentTurnResultSchema.parse({ message: "只读分析完成", actions: [{ type: "plan.submit", revision: 1, content: "核对已有测试与接口，并为双方准备共同方案。".repeat(8) }] });
    vi.spyOn(MockAgentAdapter.prototype, "run").mockResolvedValue(turn);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const replies: Array<{ status: string; result: { agentTurn: unknown } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      if (url.endsWith("/poll")) return Response.json({
        job: { id: crypto.randomUUID(), agentId: config.agentId, collaborationId, kind: "collaboration.turn", attempts: 1, payload: { context } },
      });
      if (url.endsWith("/complete")) replies.push(body);
      return Response.json(body.activeJob ? { jobState: { leaseUntil: new Date(Date.now() + 60_000).toISOString() } } : { ok: true });
    }));

    await runConnector(config);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.status).toBe("completed");
    const [action] = agentTurnResultSchema.parse(replies[0]!.result.agentTurn).actions;
    if (protocolVersion === CONNECTOR_PROTOCOL_VERSION) {
      expect(action).toMatchObject({ type: "plan.submit", baseline: { head: expect.any(String) } });
      if (action?.type !== "plan.submit") throw new Error("预期计划回执");
      expect(action.baseline?.testFiles).toHaveLength(508);
      expect(action.baseline?.testFiles?.every(file => file.path.startsWith("tests/") && file.sha256.length === 64)).toBe(true);
    } else {
      expect(action).toMatchObject({ type: "workflow.blocked", category: "code", requiresReview: true, reason: expect.stringContaining("500项") });
    }
  });
  it.each([{}, { leaseUntil: "invalid" }, { leaseUntil: new Date(0).toISOString() }, { cancelRequested: true }])("未确认当前领取轮次时不得运行本机Agent：%j", async (jobState) => {
    vi.stubEnv("SEAM_TEST_COMMAND", 'node -e \'require("node:fs").writeFileSync("executed.marker","yes")\'');
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "test-only", SEAM_PROJECT_ROOT: stateRoot });
    config.stateDir = join(stateRoot, "journal"); config.workspaceLockDir = join(stateRoot, "locks");
    const run = vi.spyOn(MockAgentAdapter.prototype, "run");
    const complete: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: any) => {
      const body = JSON.parse(options.body);
      if (url.endsWith("/poll")) return Response.json({ job: { id: crypto.randomUUID(), agentId: config.agentId, collaborationId: null, kind: "local.test", payload: {}, attempts: 1 } });
      if (url.endsWith("/complete")) complete.push(body);
      return Response.json(body.activeJob ? { jobState } : { ok: true });
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runConnector(config);
    expect(run).not.toHaveBeenCalled();
    await expect(readFile(join(stateRoot, "executed.marker"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(complete).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("未获当前轮次执行确认") })]);
  });
  it("中心拒绝完成回执时保留原始错误，不再发第二个failed回执", async () => {
    vi.stubEnv("SEAM_TEST_COMMAND", "exit 0");
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "local-secret" });
    config.stateDir = join(stateRoot, "journal"); config.workspaceLockDir = join(stateRoot, "locks");
    const jobId = crypto.randomUUID();
    config.stateDir = join(stateRoot, "journal"); config.workspaceLockDir = join(stateRoot, "locks");
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: jobId, agentId: config.agentId, collaborationId: null, kind: "local.test", payload: {}, attempts: 1 } })))
      .mockResolvedValueOnce(Response.json({ok:true,jobState:{cancelRequested:false,leaseUntil:new Date(Date.now()+1200000).toISOString()}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "original-completion-rejection" } }), { status: 422 }));
    vi.stubGlobal("fetch", request);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runConnector(config);
    const completions = request.mock.calls.filter(([url]) => String(url).endsWith("/api/connectors/complete"));
    expect(completions).toHaveLength(1);
    expect(JSON.parse(completions[0]?.[1].body)).toMatchObject({ status: "completed", result: { testRun: { status: "passed" } } });
    expect(errors).toHaveBeenCalledWith(`Connector 提交任务 ${jobId} 回执失败`, "original-completion-rejection");
  });

  it("本地执行失败正常回传一个failed回执", async () => {
    vi.stubEnv("SEAM_TEST_COMMAND", "");
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "local-secret" });
    config.stateDir = join(stateRoot, "journal"); config.workspaceLockDir = join(stateRoot, "locks");
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: crypto.randomUUID(), agentId: config.agentId, collaborationId: null, kind: "local.test", payload: {}, attempts: 1 } })))
      .mockResolvedValueOnce(Response.json({ok:true,jobState:{cancelRequested:false,leaseUntil:new Date(Date.now()+1200000).toISOString()}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", request);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runConnector(config);
    const completions = request.mock.calls.filter(([url]) => String(url).endsWith("/api/connectors/complete"));
    expect(completions).toHaveLength(1);
    expect(JSON.parse(completions[0]?.[1].body)).toMatchObject({ status: "failed", error: expect.stringContaining("SEAM_TEST_COMMAND") });
    expect(errors).not.toHaveBeenCalled();
  });
});
