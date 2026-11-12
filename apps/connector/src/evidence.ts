import { createHash } from "node:crypto";
import type { AgentTurnResult, CollaborationContext, CommandEvidence } from "@seam/protocol";
import { canonicalJson } from "@seam/protocol";

export function sanitizeOutput(output: string, projectRoot = "") {
  return output.replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[已隐藏私钥]")
    .replace(/(?:DATABASE_URL|DB_PASSWORD|SECRET_ACCESS_KEY|[A-Z_]*(?:TOKEN|PASSWORD|SECRET|API_KEY))\s*[=:]\s*\S+/gi, "[已隐藏系统密钥]")
    .replace(/(mysql|postgres(?:ql)?|https?):\/\/[^\s/]+:[^\s/]+@[^\s]+/gi, "[已隐藏连接串]")
    .replaceAll(projectRoot || "\0", "[project]");
}

export function commandText(command: string) {
  const wrapped = command.match(/^(?:\S*\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/);
  const text = (wrapped?.[2] ?? command).trim();
  // Dynamic endpoint/revision bindings are transport data, not a different
  // approved test. Keep their exact invocation separately. Never strip shell
  // substitutions, arbitrary environment options or command chains.
  const binding = /^(?:env\s+)?(?:(?:SEAM_SERVICE_URL|SEAM_REVISION)=(?:"[^"$`\\]*"|'[^']*'|[^\s'"$`;|&<>\\]+)\s+)+/;
  return text.replace(binding, "");
}

export function assertionNames(output: string) {
  return [...new Set(sanitizeOutput(output).split("\n").flatMap((line) => {
    if (/\s#\s*(?:SKIP|TODO)\b/i.test(line)) return [];
    const match = line.match(/^\s*[✔✓]\s+(.+?)(?:\s+\([\d.]+m?s\))?$/) ?? line.match(/^\s*ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/);
    return match ? [match[1]!.trim().slice(0, 500)] : [];
  }))].slice(0, 500);
}

export function captureCommand(record: { id: string; command: string; exitCode: number | null; output: string }, projectRoot: string, source: CommandEvidence["source"]): CommandEvidence | null {
  const command = commandText(record.command);
  // Upload verification output only. A read-file or source inspection command
  // is never evidence just because its stdout contains a test-looking phrase.
  if (!/^(?:(?:\/[^\s]+\/)?node\s+--test\b|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|build)\b|pytest\b|python\S*\s+-m\s+(?:pytest|unittest)\b|cargo\s+test\b|go\s+test\b)/.test(command)) return null;
  const clean = sanitizeOutput(record.output, projectRoot);
  const output = clean.length > 100_000 ? `${clean.slice(0, 99_900)}\n[输出超过100000字符；后续内容未上传]` : clean;
  const id = createHash("sha256").update(JSON.stringify([record.id, command, record.exitCode, clean])).digest("hex");
  return { id, command: sanitizeOutput(command, projectRoot), invocation: sanitizeOutput(record.command, projectRoot), exitCode: record.exitCode, output, assertions: assertionNames(output), source, capturedAt: new Date().toISOString() };
}

export function attachCommandEvidence(turn: AgentTurnResult, context: CollaborationContext, runs: CommandEvidence[]) {
  for (const action of turn.actions) {
    if (action.type !== "execution.report" && action.type !== "integration.report") continue;
    action.runs = [...new Map(runs.map((run) => [run.id, run])).values()];
    if (action.type !== "integration.report") continue;
    for (const check of action.checks) {
      const approved = context.lifecycle?.contract?.acceptanceCases.find((item) => item.id === check.caseId && item.runnerParticipantId === context.participant.id);
      const required = approved?.requiredAssertions ?? [];
      if (check.status === "passed" && required.some((name) => !check.assertionNames.includes(name))) throw new Error(`联合用例 ${check.caseId} 未完整报告已批准的必需断言；未发布通过结论`);
      const matching = action.runs.filter((run) => approved && commandText(run.command) === commandText(approved.command) && commandText(check.command) === commandText(approved.command));
      if (matching.length && approved) check.command = approved.command;
      // IDs are assigned from observed local events, never trusted from a model.
      check.runIds = matching.filter((run) => check.assertionNames.length > 0 && check.assertionNames.every((name) => run.assertions.includes(name)) && (check.status !== "passed" || run.exitCode === 0)).map((run) => run.id);
      if (check.status === "passed" && required.some((name) => !matching.some((run) => run.exitCode === 0 && run.assertions.includes(name)))) throw new Error(`联合用例 ${check.caseId} 的必需断言没有全部实际通过；未发布通过结论`);
      if (check.status === "passed" && !check.runIds.length) throw new Error(`联合用例 ${check.caseId} 缺少匹配批准命令及实际断言的成功记录；未发布通过结论`);
    }
  }
  return turn;
}

export class ServiceReadinessError extends Error {}
export async function probeServices(turn: AgentTurnResult, signal?: AbortSignal, context?: CollaborationContext) {
  for (const action of turn.actions) {
    if (action.type !== "service.publish") continue;
    const base = new URL(action.baseUrl);
    const health = new URL(action.healthPath || "/", base);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || health.origin !== base.origin) throw new Error("服务地址必须是同源 HTTP(S) 地址且不能包含凭据");
    const lifecycle = context?.lifecycle;
    const expectations = lifecycle?.contract?.serviceExpectations;
    const expected = expectations?.find((item) => item.name === action.name && item.publisherParticipantId === context!.participant.id);
    if (expectations && !expected) throw new ServiceReadinessError("服务没有本方已批准的就绪契约，不能发布。");
    if (expected && expected.healthPath !== action.healthPath) throw new ServiceReadinessError("健康探测路径与已批准契约不符，未发布服务。");
    let response: Response;
    try { response = await fetch(health, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), redirect: "error" }); }
    catch { throw new ServiceReadinessError("本地服务就绪探测暂不可达，未发布服务地址。"); }
    if (!response.ok || (expected && response.status !== expected.status)) { await response.body?.cancel(); throw new ServiceReadinessError(`本地服务就绪探测失败，HTTP ${response.status}；未发布服务`); }
    if (expected?.bodyChecks.length) {
      const reader = response.body?.getReader(); let text = "", bytes = 0;
      try {
        if (!reader) throw new Error("empty body");
        const decoder = new TextDecoder();
        while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 65_536) throw new Error("oversize body"); text += decoder.decode(chunk.value, { stream: true }); }
        text += decoder.decode();
        const body: unknown = JSON.parse(text);
        for (const check of expected.bodyChecks) {
          let value = body;
          for (const key of check.path.split(".")) value = value !== null && typeof value === "object" && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
          if (value !== check.equals) throw new Error("body mismatch");
        }
      } catch { throw new ServiceReadinessError("健康响应未满足已批准的就绪字段或修订要求，未发布服务。"); }
      finally { await reader?.cancel().catch(() => {}); }
    } else await response.body?.cancel();
    action.probe = { ok: true, status: response.status, checkedAt: new Date().toISOString(), ...(expected ? {
      expectationHash: createHash("sha256").update(canonicalJson(expected)).digest("hex"), documentHash: lifecycle!.documentHash!, revision: lifecycle!.revision,
    } : {}) };
  }
}
