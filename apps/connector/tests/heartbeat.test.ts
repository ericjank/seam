import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalTest } from "../src/local-test";
import { readConfig } from "../src/config";
import { runConnector } from "../src/index";

vi.mock("../src/local-test.js", () => ({ runLocalTest: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Connector 长任务心跳", () => {
  it("长任务期间每20秒独立续心跳，心跳失败不中断任务或产生第二回执，结束后停止", async () => {
    vi.useFakeTimers();
    let finish!: (value: { status: "passed"; summary: string; evidence: Record<string, never> }) => void;
    vi.mocked(runLocalTest).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const config = readConfig(["--once"], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "private-token" });
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
