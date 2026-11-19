import { createHash } from "node:crypto";
import { canonicalJson, expandSharedContract, objectionTargetKey, type PlanObjection, type PlanObjectionChange, type PlanObjectionEvidence, type SharedContract, type SharedFact } from "@seam/protocol";
import { bindFacts, factsReady } from "./fact-bindings";
import { HttpError } from "./http";

export const OBJECTION_NO_PROGRESS_LIMIT = 2;
export type StoredPlanObjection = PlanObjection & { seen: string[] };
export type PlanObjectionState = { items: StoredPlanObjection[]; draft: SharedContract | null };

type Target = PlanObjection["target"];
const normalizeText = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
const fingerprint = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export function hasObjectionTarget(contract: SharedContract, target: Target) {
  if (target.kind === "requirement") return contract.effectiveRequirements?.some(row => row.id === target.id) ?? false;
  if (target.kind === "acceptance_case") return contract.acceptanceCases.some(row => row.id === target.id);
  // An existing interface can be challenged for omitting a specific field.
  return contract.interfaces.some(row => row.id === target.id);
}

export function objectionTargetFingerprint(contract: SharedContract, target: Target) {
  let value: unknown = null;
  if (target.kind === "requirement") {
    const row = contract.effectiveRequirements?.find(item => item.id === target.id);
    if (row) value = [normalizeText(row.text), row.verification ?? null];
  } else if (target.kind === "interface_field") {
    const row = contract.interfaces.find(item => item.id === target.id)?.fields?.find(field => field.path === target.path);
    if (row) value = normalizeText(row.definition);
  } else {
    const row = expandSharedContract(contract).acceptanceCases.find(item => item.id === target.id);
    if (row) value = {
      runner: row.runnerParticipantId, command: row.command.trim(), expected: normalizeText(row.expectedResult),
      assertions: [...(row.requiredAssertions ?? [])].map(normalizeText).sort(),
      httpChecks: [...(row.httpChecks ?? [])].map(({ id: _id, ...check }) => ({
        ...check,
        bodyChecks: [...check.bodyChecks].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
        bodyAssertions: [...(check.bodyAssertions ?? [])].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
        headerChecks: [...(check.headerChecks ?? [])].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
        requirementIds: [...(check.requirementIds ?? [])].sort(),
        emptyBody: check.emptyBody ?? false,
      })).map(canonicalJson).sort(),
    };
  }
  return fingerprint(["target", objectionTargetKey(target), value]);
}

export function applyObjectionChange(contract: SharedContract, target: Target, change: PlanObjectionChange) {
  if (!hasObjectionTarget(contract, target)) throw new HttpError(422, "此异议所指的契约项已变化，请补充新证据说明原因");
  if (target.kind === "requirement" && change.kind === "requirement" && change.requirement.id === target.id) {
    return { ...contract, effectiveRequirements: contract.effectiveRequirements?.map(row => row.id === target.id ? change.requirement : row) };
  }
  if (target.kind === "interface_field" && change.kind === "interface_field" && change.field.path === target.path) {
    return { ...contract, interfaces: contract.interfaces.map(row => row.id !== target.id ? row : {
      ...row, fields: [...(row.fields ?? []).filter(field => field.path !== target.path), change.field],
    }) };
  }
  if (target.kind === "acceptance_case" && change.kind === "acceptance_case" && change.acceptanceCase.id === target.id && !change.acceptanceCase.httpCheckRefs) {
    const expanded = expandSharedContract(contract);
    return { ...expanded, acceptanceCases: expanded.acceptanceCases.map(row => row.id === target.id ? change.acceptanceCase : row) };
  }
  throw new HttpError(422, "只可修改该异议绑定的需求、字段或验收用例；修改用例时提供完整内联HTTP检查");
}

export function objectionEvidence(evidence: PlanObjectionEvidence, facts: SharedFact[], revision: number) {
  if (evidence.kind === "project_file") {
    if (!evidence.contentHash) throw new HttpError(422, "Connector 未能核验该项目内证据文件，请提供可读的相对路径或已核验共享事实");
    return { digest: fingerprint(["file", evidence.contentHash]),
      response: { kind: evidence.kind, detail: `${evidence.path}（SHA-256 ${evidence.contentHash}）\n${evidence.finding}` } };
  }
  if (!factsReady([evidence.key], facts, revision)) throw new HttpError(422, "共享事实缺失、已过期或尚未核验本修订");
  const binding = bindFacts([evidence.key], facts)[0]!;
  return { digest: fingerprint(["fact", binding.value, binding.sourceHash]), response: {
    kind: evidence.kind, detail: `${binding.key} = ${binding.value}（来源指纹 ${binding.sourceHash}）`,
  } };
}

export function administratorObjectionEvidence(evidence: string) {
  return { digest: fingerprint(["administrator", normalizeText(evidence)]), response: { kind: "administrator" as const, detail: evidence.trim() } };
}

export function failedObjectionAttempt(row: StoredPlanObjection, detail: string): StoredPlanObjection {
  const noProgressRounds = row.noProgressRounds + 1;
  return { ...row, attempts: row.attempts + 1, noProgressRounds, lastAttempt: detail.slice(0, 5000),
    state: noProgressRounds >= OBJECTION_NO_PROGRESS_LIMIT ? "paused" : "open" };
}
