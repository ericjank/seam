import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config";
import { diagnoseConnector } from "../src/doctor";
import { PlatformClient } from "../src/client";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("本机接入诊断", () => {
  it("无中心凭据可诊断，本地策略必须明确配置", async () => {
    const config = readConfig(["--doctor", "--adapter", "mock"], {});
    expect(config.codexSandbox).toBe("read-only");
    const report = await diagnoseConnector(config);
    expect(report.ok).toBe(true);
    expect(report.platformCredentialsConfigured).toBe(false);
    expect(JSON.stringify(report)).not.toContain('"token"');
    expect(readConfig(["--doctor", "--codex-sandbox", "workspace-write"], {}).codexSandbox).toBe("workspace-write");
  });

  it("配置错误在启动前给出明确错误", () => {
    expect(() => readConfig(["--doctor", "--codex-sandbox", "danger-full-access"], {})).toThrow();
    expect(() => readConfig(["--doctor", "--adapter", "unknown"], {})).toThrow();
    expect(() => readConfig(["--doctor", "--adapter"], {})).toThrow("缺少值");
    expect(() => readConfig(["--doctor"], { SEAM_POLL_INTERVAL_MS: "NaN" })).toThrow();
    expect(() => readConfig([], {})).toThrow("SEAM_AGENT_ID");
  });

  it("不存在的目录诊断失败，不运行本地任务", async () => {
    const config = readConfig(["--doctor", "--project-root", "/this/seam-project-does-not-exist"], {});
    expect((await diagnoseConnector(config)).ok).toBe(false);
  });

  it("完成请求自动携带最近领取的attempts，避免旧worker确认新租约", async () => {
    const jobId = crypto.randomUUID();
    const config = readConfig([], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "local-secret" });
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: jobId, agentId: config.agentId, collaborationId: null, kind: "local.test", status: "running", payload: {}, attempts: 2 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", request);
    const client = new PlatformClient(config);
    expect((await client.poll())?.attempts).toBe(2);
    await client.complete(jobId, { ok: true });
    expect(JSON.parse(request.mock.calls[1]?.[1].body)).toMatchObject({ jobId, attempts: 2, status: "completed" });
  });

  it("心跳仅声明本地配置能力，令牌留在认证头且不上传路径/命令", async () => {
    const config = readConfig([], { SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "local-secret", SEAM_PROJECT_ROOT: "/private/project" });
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", request);
    await new PlatformClient(config).heartbeat({ adapter: "codex", executionMode: "read-only", testConfigured: true });
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({
      agentId: config.agentId, capabilities: { adapter: "codex", executionMode: "read-only", testConfigured: true },
    });
    expect(request.mock.calls[0]?.[1].body).not.toContain("local-secret");
    expect(request.mock.calls[0]?.[1].body).not.toContain("/private/project");
  });
});
