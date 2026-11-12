import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { agentTurnResultSchema, collaborationContextSchema } from "@seam/protocol";
import { assertionNames, attachCommandEvidence, captureCommand, commandText, probeServices, ServiceReadinessError } from "../src/evidence";

afterEach(() => vi.unstubAllGlobals());
describe("实际命令证据和就绪发布", () => {
  const command = "node --test joint.test.mjs";
  const output = "TAP version 13\n# Subtest: HTTP rejects null\nok 1 - HTTP rejects null\n# Subtest: quote amount\nok 2 - quote amount\n";
  const observed = () => captureCommand({ id: "real-command", command: `/bin/zsh -lc '${command}'`, exitCode: 0, output }, "/private/project", "codex-app-server")!;
  it("动态服务绑定保留真实调用并匹配批准命令，不把其他环境或组合命令当成同一测试", () => {
    const invocation = `/bin/zsh -lc 'SEAM_SERVICE_URL=http://127.0.0.1:12345 SEAM_REVISION=2 ${command}'`;
    const run = captureCommand({ id: "bound", command: invocation, exitCode: 0, output }, "", "codex-app-server")!;
    expect(run.command).toBe(command); expect(run.invocation).toBe(invocation);
    expect(commandText(`env SEAM_SERVICE_URL="http://127.0.0.1:12345" ${command}`)).toBe(command);
    for (const other of [`NODE_OPTIONS='--require hidden.mjs' ${command}`, `SEAM_SERVICE_URL=$(other) ${command}`, `echo ready && ${command}`]) {
      expect(captureCommand({ id: "other", command: other, exitCode: 0, output }, "", "codex-app-server")).toBeNull();
    }
  });
  it("只采集真实测试命令，断言去重，过滤源码读取输出与密钥", () => {
    expect(captureCommand({ id: "cat", command: "cat source.ts", exitCode: 0, output }, "", "codex-app-server")).toBeNull();
    expect(observed().assertions).toEqual(["HTTP rejects null", "quote amount"]);
    expect(assertionNames("✔ quote amount (3.52ms)\n✔ bad quantity (0.81ms)\n")).toEqual(["quote amount", "bad quantity"]);
    expect(assertionNames("# Subtest: skipped case\nok 1 - skipped case # SKIP unavailable\n# Subtest: todo case\nnot ok 2 - todo case # TODO\n")).toEqual([]);
    const run = captureCommand({ id: "test", command, exitCode: 0, output: output + "API_KEY=abc123\n/private/project/tests.mjs" }, "/private/project", "local-test")!;
    expect(run.output).not.toContain("abc123"); expect(run.output).not.toContain("/private/project");
  });
  it("通过必须匹配本方批准命令、实际断言和成功退出码，不能沿用模型自造runId", () => {
    const id = crypto.randomUUID(), peer = crypto.randomUUID();
    const context = collaborationContextSchema.parse({ collaborationId: crypto.randomUUID(), title: "evidence", objective: "实际断言", type: "custom", status: "in_progress", participant: { id, projectId: crypto.randomUUID(), projectName: "本方", agentId: null, agentName: null, role: "consumer", approvalRequired: true, status: "active" }, participants: [], messages: [], artifacts: [], workItems: [], lifecycle: { revision: 1, phase: "joint_verifying", requirements: "evidence", document: null, documentHash: "a".repeat(64), approvedHash: "a".repeat(64), requiredParticipantIds: [id], contributions: [], confirmations: [], reports: [], report: null, contract: { scope: "isolated verification of real HTTP quote errors", interfaces: [{ id: "quote", definition: "HTTP POST JSON reports errors with status 400" }], responsibilities: [id, peer].map((participantId) => ({ participantId, changes: "Implement real HTTP quote tests and verify errors" })), acceptanceCases: [id,peer].map((runnerParticipantId,index)=>({ id: index === 0 ? "errors" : "peer-errors", runnerParticipantId, command, description: "verify real HTTP errors", expectedResult: "400" })), risks: "test", changeSummary: "Verify actual assertions against approved cases", impactedParticipantIds: [id], retainedDecisions: [] } } });
    const turn = () => agentTurnResultSchema.parse({ message: "实际测试", actions: [{ type: "integration.report", revision: 1, documentHash: "a".repeat(64), checks: [{ caseId: "errors", status: "passed", command, summary: "HTTP400", assertionNames: ["HTTP rejects null"], runIds: ["invented"], evidence: { details: "short" } }] }] });
    const result = attachCommandEvidence(turn(), context, [observed(), observed()]);
    const action = result.actions[0];
    expect(action.type).toBe("integration.report");
    if (action.type !== "integration.report") throw new Error("unexpected");
    expect(action.runs).toHaveLength(1); expect(action.checks[0]!.runIds).toEqual([observed().id]);
    expect(() => attachCommandEvidence(turn(), context, [{ ...observed(), assertions: ["different assertion"] }])).toThrow("实际断言");
    expect(() => attachCommandEvidence(turn(), context, [{ ...observed(), exitCode: 1 }])).toThrow("成功记录");
    expect(() => attachCommandEvidence(turn(), context, [{ ...observed(), command: "node --test other.test.mjs" }])).toThrow("批准命令");
    context.lifecycle!.contract!.acceptanceCases[0]!.requiredAssertions = ["HTTP rejects null", "quote amount"];
    expect(() => attachCommandEvidence(turn(), context, [observed()])).toThrow("完整报告");
    const complete = turn(); if (complete.actions[0]?.type !== "integration.report") throw new Error("unexpected");
    complete.actions[0].checks[0]!.assertionNames = ["HTTP rejects null", "quote amount"];
    expect(() => attachCommandEvidence(complete, context, [{ ...observed(), assertions: ["HTTP rejects null"] }])).toThrow();
    expect(() => attachCommandEvidence(complete, context, [observed()])).not.toThrow();
  });
  it("HTTP200但未就绪、旧修订、缺字段、错误类型、非JSON及超大响应不能发布", async () => {
    const id = crypto.randomUUID();
    const context = collaborationContextSchema.parse({ collaborationId: crypto.randomUUID(), title: "health", objective: "就绪", type: "custom", status: "in_progress", participant: { id, projectId: crypto.randomUUID(), projectName: "本方", agentId: null, agentName: null, role: "provider", approvalRequired: true, status: "active" }, participants: [], messages: [], artifacts: [], workItems: [] });
    context.lifecycle = { revision: 2, phase: "executing", documentHash: "a".repeat(64), approvedHash: "a".repeat(64), contract: { serviceExpectations: [{ name: "quote", publisherParticipantId: id, healthPath: "/health", status: 200, bodyChecks: [{ path: "ready", equals: true }, { path: "revision", equals: 2 }] }] } } as unknown as typeof context.lifecycle;
    const turn = () => agentTurnResultSchema.parse({ message: "服务", actions: [{ type: "service.publish", revision: 2, name: "quote", baseUrl: "http://127.0.0.1:12345", healthPath: "/health", ttlSeconds: 300 }] });
    for (const body of ['{"ready":false,"revision":2}', '{"ready":true,"revision":1}', '{"ready":true}', '{"ready":"true","revision":2}', 'not json', "x".repeat(70_000)]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
      await expect(probeServices(turn(), undefined, context)).rejects.toBeInstanceOf(ServiceReadinessError);
    }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ready: true, revision: 2 })));
    const valid = turn(); await probeServices(valid, undefined, context);
    expect(valid.actions[0]).toMatchObject({ probe: { ok: true, revision: 2, documentHash: "a".repeat(64) } });
  });
  it("发布前从Connector真实探测健康地址，失败不形成就绪记录", async () => {
    let ready = false;
    const server = createServer((_request, response) => response.writeHead(ready ? 200 : 503).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
      const turn = agentTurnResultSchema.parse({ message: "服务", actions: [{ type: "service.publish", revision: 1, name: "quote", baseUrl: `http://127.0.0.1:${address.port}`, healthPath: "/health", ttlSeconds: 300 }] });
      await expect(probeServices(turn)).rejects.toBeInstanceOf(ServiceReadinessError);
      expect(turn.actions[0]).not.toHaveProperty("probe"); ready = true;
      await probeServices(turn); expect(turn.actions[0]).toMatchObject({ probe: { ok: true, status: 200 } });
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("拒绝带凭据与跨源健康地址，不发出请求", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const [baseUrl, healthPath] of [["http://user:secret@localhost:9999", "/health"], ["http://localhost:9999", "http://other.invalid/health"]]) {
      const turn = agentTurnResultSchema.parse({ message: "服务", actions: [{ type: "service.publish", revision: 1, name: "test", baseUrl, healthPath, ttlSeconds: 300 }] });
      await expect(probeServices(turn)).rejects.toThrow("同源");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
