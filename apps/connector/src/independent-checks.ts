import { createHash } from "node:crypto";
import { canonicalJson, type AgentTurnResult, type CollaborationContext, type CommandEvidence } from "@seam/protocol";
import { commandText } from "./evidence.js";

export async function runIndependentChecks(context: CollaborationContext, networkAllowed: boolean, signal: AbortSignal) {
  const results: NonNullable<Extract<AgentTurnResult["actions"][number], { type: "integration.report" }>["independentResults"]> = [];
  const lifecycle = context.lifecycle;
  if (!lifecycle || lifecycle.paused || lifecycle.phase !== "joint_verifying" || lifecycle.approvedHash !== lifecycle.documentHash || !lifecycle.approvedHash || context.informationTask) return results;
  for (const item of lifecycle.contract?.acceptanceCases.filter(row => row.runnerParticipantId === context.participant.id) ?? []) for (const check of item.httpChecks ?? []) {
    const base = { id: check.id, caseId: item.id, specHash: createHash("sha256").update(canonicalJson(check)).digest("hex"), documentHash: lifecycle.approvedHash, capturedAt: new Date().toISOString(), actualStatus: null as number | null };
    const unavailable = (summary: string, category: "environment" | "authorization" = "environment") => ({ ...base, status: "not_run" as const, category, summary });
    if (!networkAllowed) { results.push(unavailable("本机未允许网络访问，独立HTTP验收未执行。", "authorization")); continue; }
    const service = lifecycle.services.find(row => row.participantId === check.publisherParticipantId && row.name === check.serviceName && Date.parse(row.expiresAt) > Date.now());
    if (!service) { results.push(unavailable("当前批准修订没有有效的目标服务发布记录。")); continue; }
    try {
      const url = new URL(check.path, service.baseUrl), origin = new URL(service.baseUrl);
      if (url.origin !== origin.origin || url.username || url.password || !check.path.startsWith("/") || check.path.startsWith("//")) throw new Error("独立验收路径越出批准的服务范围");
      const response = await fetch(url, { method: check.method, headers: { "content-type": "application/json" }, ...(check.method !== "GET" && check.requestBody !== null ? { body: check.requestBody } : {}), redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      base.actualStatus = response.status;
      let passed = response.status === check.expectedStatus;
      if (check.bodyChecks.length) {
        const reader = response.body?.getReader(); let bytes = 0, text = "";
        try {
          if (!reader) throw new Error("HTTP响应没有可读取正文");
          const decoder = new TextDecoder();
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 65_536) throw new Error("HTTP验收响应超过65536字节"); text += decoder.decode(chunk.value, { stream: true }); }
          text += decoder.decode(); let body: unknown; try { body = JSON.parse(text); } catch { body = undefined; }
          for (const field of check.bodyChecks) {
            let value = field.path === "$text" ? text : body;
            for (const key of ["$", "$text"].includes(field.path) ? [] : field.path.split(".")) value = value !== null && typeof value === "object" && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
            const expected = field.equals === "$SEAM_REVISION" ? lifecycle.revision : field.equals;
            if (value !== expected) passed = false;
          }
        } catch { passed = false; }
        finally { await reader?.cancel().catch(() => {}); }
      } else await response.body?.cancel();
      results.push({ ...base, status: passed ? "passed" : "failed", category: "code", summary: passed ? "固定Connector按批准的请求、状态码和字段期望独立验收通过。" : "独立HTTP响应不符合批准契约；测试输出不能替代该结果。" });
    } catch (error) {
      if (signal.aborted) throw error;
      results.push(unavailable("独立HTTP请求不可达或执行超时，尚不能判断业务代码是否正确。"));
    }
  }
  return results;
}

/** A configured local command and complete observed assertions permit a deterministic receipt. */
export function buildConfiguredIntegrationReport(context: CollaborationContext, configuredCommand: string | undefined, runs: CommandEvidence[], independentResults: Awaited<ReturnType<typeof runIndependentChecks>>): AgentTurnResult | null {
  const lifecycle = context.lifecycle;
  const cases = lifecycle?.contract?.acceptanceCases.filter(row => row.runnerParticipantId === context.participant.id) ?? [];
  if (!lifecycle || lifecycle.paused || context.informationTask || lifecycle.phase !== "joint_verifying" || !lifecycle.approvedHash || lifecycle.approvedHash !== lifecycle.documentHash || !configuredCommand || !cases.length || cases.some(row => commandText(row.command) !== commandText(configuredCommand))) return null;
  const checks = cases.map(item => {
    const observed = runs.filter(row => commandText(row.command) === commandText(item.command));
    const oracle = independentResults.filter(row => row.caseId === item.id), missing = oracle.find(row => row.status === "not_run");
    const failed = oracle.some(row => row.status === "failed") || observed.some(row => row.exitCode !== 0);
    const codeFailure = oracle.some(row => row.status === "failed") || observed.some(row => row.exitCode !== 0 && /(?:not ok \d+|ERR_ASSERTION|AssertionError)/.test(row.output));
    const required = item.requiredAssertions ?? [];
    const assertions = [...new Set(observed.filter(row => row.exitCode === 0).flatMap(row => row.assertions))];
    const passed = observed.length > 0 && !failed && !missing && required.every(name => assertions.includes(name)) && oracle.every(row => row.status === "passed");
    return { caseId: item.id, command: item.command, status: missing ? "not_run" as const : passed ? "passed" as const : "failed" as const,
      category: missing?.category ?? (codeFailure ? "code" as const : "unknown" as const), summary: missing?.summary ?? (passed ? "Connector已运行本机配置命令并核对完整必需断言和独立契约结果，自动汇总实际回执。" : "配置命令失败或未覆盖完整必需断言，保留原始输出并停止通过结论。"),
      evidence: { automaticReceipt: true }, assertionNames: assertions, runIds: observed.map(row => row.id) };
  });
  return { message: "Connector依据实际命令与独立HTTP结果直接汇总本轮联合验收，无需调用模型重复转写测试报告。", kind: "status", notifyParticipantIds: [], needsHumanInput: false,
    actions: [{ type: "integration.report", revision: lifecycle.revision, documentHash: lifecycle.approvedHash!, checks, runs, independentResults }] };
}
