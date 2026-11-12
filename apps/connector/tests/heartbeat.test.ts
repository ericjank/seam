import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLocalTest } from "../src/local-test";
import { readConfig } from "../src/config";
import { runConnector } from "../src/index";

vi.mock("../src/workspace.js", () => ({ withWorkspaceLock: vi.fn(async (_root, _signal, run) => run()), workspaceBaseline: vi.fn(async () => null) }));
vi.mock("../src/journal.js", () => ({ ExecutionJournal: class { async pending() { return []; } async pendingControls() { return []; } async saveControl() {} async begin() { return null; } async save() {} } }));
vi.mock("../src/local-test.js", () => ({ runLocalTest: vi.fn() }));
let stateRoot: string;
beforeEach(async () => { stateRoot = await mkdtemp(join(tmpdir(), "seam-connector-test-")); });
afterEach(async () => { await rm(stateRoot, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Connector 长任务心跳", () => {
  it("平台暂停通知传递到执行信号，停止后才回传取消确认", async () => {
    vi.useFakeTimers();
    const jobId = crypto.randomUUID();
    let stopped = false;
    vi.mocked(runLocalTest).mockImplementation((_root, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => { stopped = true; reject(new Error("local execution interrupted")); }, { once: true });
    }));
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "test-only" });
    const acknowledgements: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: any) => {
      const body = JSON.parse(options.body);
      if (url.endsWith("/poll")) return new Response(JSON.stringify({ job: { id: jobId, agentId: config.agentId, collaborationId: null, kind: "local.test", payload: {}, attempts: 1 } }));
      if (body.activeJob?.cancelled) { expect(stopped).toBe(true); acknowledgements.push(body.activeJob); }
      return new Response(JSON.stringify({ ok: true, ...(body.activeJob ? { jobState: { cancelRequested: true } } : {}) }));
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pending = runConnector(config);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(stopped).toBe(true);
    expect(acknowledgements).toEqual([{ id: jobId, attempts: 1, cancelled: true }]);
  });

  it("长任务期间每20秒独立续心跳，心跳失败不中断任务或产生第二回执，结束后停止", async () => {
    vi.useFakeTimers();
    let finish!: (value: { status: "passed"; summary: string; evidence: Record<string, never> }) => void;
    vi.mocked(runLocalTest).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "private-token" });
    config.stateDir = join(stateRoot, "journal"); config.workspaceLockDir = join(stateRoot, "locks");
    let heartbeatCount = 0;
    const request = vi.fn(async (url: string) => {
      if (url.endsWith("/heartbeat")) {
        heartbeatCount += 1;
        if (heartbeatCount === 2) throw new Error("temporary heartbeat outage");
        return new Response(JSON.stringify({ ok: true }));
      }
      if (url.endsWith("/poll")) return new Response(JSON.stringify({ job: { id: crypto.randomUUID(), agentId: config.agentId, collaborationId: null, kind: "local.test", payload: {}, attempts: 1 } }));
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", request);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = runConnector(config);
    await vi.advanceTimersByTimeAsync(0);
    expect(runLocalTest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(heartbeatCount).toBe(6);
    expect(errors).toHaveBeenCalledWith("Connector 心跳失败", "temporary heartbeat outage");
    finish({ status: "passed", summary: "真实本地测试通过", evidence: {} });
    await pending;
    expect(request.mock.calls.filter(([url]) => url.endsWith("/complete"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(heartbeatCount).toBe(6);
  });
});
