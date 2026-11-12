import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnector } from "../src/index";
import { readConfig } from "../src/config";

let stateRoot: string;
beforeEach(async () => { stateRoot = await mkdtemp(join(tmpdir(), "seam-connector-test-")); });
afterEach(async () => { await rm(stateRoot, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Connector 回执交付", () => {
  it("中心拒绝完成回执时保留原始错误，不再发第二个failed回执", async () => {
    vi.stubEnv("SEAM_TEST_COMMAND", "exit 0");
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "local-secret" });
    config.stateDir = join(stateRoot, "journal"); config.workspaceLockDir = join(stateRoot, "locks");
    const jobId = crypto.randomUUID();
    config.stateDir = join(stateRoot, "journal"); config.workspaceLockDir = join(stateRoot, "locks");
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: jobId, agentId: config.agentId, collaborationId: null, kind: "local.test", payload: {}, attempts: 1 } })))
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
