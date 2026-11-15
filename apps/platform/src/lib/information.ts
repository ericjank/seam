import { createHash } from "node:crypto";
import { type InformationRequest, type SharedFact, type LifecycleAgentAction } from "@seam/protocol";
import { HttpError } from "./http";

export const MAX_INFORMATION_FAILURES = 3;
export const MAX_INFORMATION_REQUESTS = 500;
export const INFORMATION_TIMEOUT_MS = 10 * 60_000;
type Source = InformationRequest["responses"][number]["sources"][number];
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
export const informationKey = (question: string, key?: string) => key?.trim() || createHash("sha256").update(normalize(question).toLowerCase()).digest("hex");
const deadline = (now: number) => new Date(now + INFORMATION_TIMEOUT_MS).toISOString();

export function validateInformationSources(sources: Source[], localSearch = false) {
  if (sources.some(source => source.scope === "local_project" && (/^(?:\/|~[\\/]|[A-Za-z]:[\\/]|file:)/.test(source.reference.trim())
    || /(?:^|[\\/])(?:\.\.|\.env(?:\..*)?|id_rsa|id_ed25519|credentials)(?:$|[\\/])/i.test(source.reference)))) throw new HttpError(422, "只引用相对项目资料，不得查找或分享本机秘密文件");
  if (localSearch && (!["local_project", "shared_context"].every(scope => sources.some(source => source.scope === scope)))) throw new HttpError(422, "转询对端前必须记录本地项目与共享资料的检索结果");
}

export function openInformationRequest(input: {
  requests: InformationRequest[]; id: string; revision: number; phase: string; participantId: string;
  requiredParticipantIds: string[]; question: string; searched?: Source[]; now: string;
  key?: string; fresh?: boolean; facts?: SharedFact[]; resumeRequiresReview?: boolean; forceVerifyKey?: string; purpose?: InformationRequest["purpose"];
}) {
  if (input.searched) validateInformationSources(input.searched, true);
  const key = informationKey(input.question, input.key);
  const same = input.requests.filter(row => row.revision === input.revision && row.requestedByParticipantId === input.participantId && informationKey(row.question, row.key) === key);
  const duplicate = same.find(row => ["pending", "conflicted"].includes(row.status) && row.phase === input.phase);
  if (duplicate) return { requests: input.requests, request: duplicate };
  if (same.filter(row => row.status === "needs_admin").reduce((sum, row) => sum + (row.retryCount ?? 0) + 1, 0) >= MAX_INFORMATION_FAILURES
    || input.requests.length >= MAX_INFORMATION_REQUESTS) return { requests: input.requests, request: null };
  const now = Date.parse(input.now), fact = input.forceVerifyKey ? input.facts?.find(row => row.key === input.forceVerifyKey && row.status !== "conflicted") : input.fresh ? undefined : input.facts?.find(row => row.key === key && row.status === "active" && Date.parse(row.validUntil) > now);
  const peers = input.requiredParticipantIds.filter(id => id !== input.participantId);
  const request: InformationRequest = {
    id: input.id, key, revision: input.revision, phase: input.phase, question: input.question, purpose: input.purpose,
    requestedByParticipantId: input.participantId, peerParticipantIds: peers,
    targetParticipantIds: fact ? [...new Set(fact.responses.map(row => row.participantId))] : peers,
    stage: fact ? "verify" : input.searched ? "peer" : "local", status: "pending", answer: null, createdAt: input.now,
    attempt: 1, retryCount: 0, deadlineAt: deadline(now), retryAt: null, resumeRequiresReview: input.resumeRequiresReview,
    ...(fact ? { cachedFactKey: fact.key } : {}),
    responses: input.searched && !fact ? [{ participantId: input.participantId, mode: "local", attempt: 1, status: "unavailable", answer: "本地与共享资料未解决该问题，向对端询证。", sources: input.searched }] : [],
  };
  if (fact?.authority === "administrator" && Date.parse(fact.validUntil)>now) {
    request.status = "answered"; request.answer = fact.answer; request.responses = fact.responses.map(row => ({ ...row, attempt: 1 }));
  }
  return { requests: [...input.requests, request], request };
}

export function retryInformationRequest(request: InformationRequest, now: number, reason: string): InformationRequest {
  const retries = (request.retryCount ?? 0) + 1;
  if (retries >= MAX_INFORMATION_FAILURES) return { ...request, status: "needs_admin", retryAt: null, failureReason: reason };
  const retryAt = now + Math.min(30_000, 1000 * 2 ** retries);
  return { ...request, attempt: (request.attempt ?? 1) + 1, retryCount: retries, retryAt: new Date(retryAt).toISOString(), deadlineAt: deadline(retryAt), failureReason: reason };
}

export function expireInformationRequest(request: InformationRequest, now: number) {
  if (!["pending", "conflicted"].includes(request.status)) return request;
  const expires = request.deadlineAt ? Date.parse(request.deadlineAt) : Date.parse(request.createdAt) + INFORMATION_TIMEOUT_MS;
  return now < expires ? request : retryInformationRequest(request, now, "信息查找超时；请确认对端在线且Connector支持当前协议，恢复后可重新查找。");
}

export function answerInformationRequest(request: InformationRequest, participantId: string,
  action: Extract<LifecycleAgentAction, { type: "information.respond" }>, phase: string, now = Date.now()) {
  const attempt = request.attempt ?? 1;
  if (!["pending", "conflicted"].includes(request.status) || request.revision !== action.revision || request.phase !== phase || (action.attempt ?? 1) !== attempt) throw new HttpError(409, "信息请求已失效、查找轮次已变化或已处理");
  const local = request.stage === "local", mode = local ? "local" as const : "peer" as const;
  if (local ? request.requestedByParticipantId !== participantId : !request.targetParticipantIds.includes(participantId)) throw new HttpError(403, "只能处理分配给本方的信息查找任务");
  if (request.responses.some(row => row.mode === mode && row.participantId === participantId && (row.attempt ?? 1) === attempt)) throw new HttpError(409, "本方已答复此信息请求");
  validateInformationSources(action.sources, local && action.status === "unavailable");
  if (!local && action.status === "unavailable" && !action.sources.some(source => source.scope === "local_project")) throw new HttpError(422, "对端无法答复时必须记录本方项目资料的检索来源");
  const response = { participantId, mode, status: action.status, answer: action.answer, value: action.value?.trim() || action.answer.trim(),
    sources: action.sources, diagnosisCategory:action.diagnosisCategory, attempt, validForSeconds: action.validForSeconds ?? 3600 };
  const updated = { ...request, responses: [...request.responses, response] };
  if (local) {
    if (action.status === "found") return { ...updated, status: "answered" as const, answer: action.answer, failureReason: undefined };
    return { ...updated, stage: "peer" as const, deadlineAt: deadline(now), retryCount: 0 };
  }
  const replies = updated.responses.filter(row => row.mode === "peer" && (row.attempt ?? 1) === attempt);
  if (!request.targetParticipantIds.every(id => replies.some(row => row.participantId === id))) return updated;
  const found = replies.filter(row => row.status === "found");
  if (request.stage === "verify" && found.length !== replies.length) return { ...updated, stage: "local" as const, status: "pending" as const,
    targetParticipantIds: request.peerParticipantIds ?? request.targetParticipantIds.filter(id => id !== request.requestedByParticipantId),
    attempt: attempt + 1, retryCount: 0, deadlineAt: deadline(now), failureReason: "缓存来源已变化或无法核对，重新检索当前资料。" };
  if (!found.length) return { ...updated, status: "needs_admin" as const, answer: null, failureReason: "本地、共享资料及指定对端均未找到可核对的事实。" };
  const values = new Set(found.map(row => normalize(row.value ?? row.answer)));
  if (values.size > 1 || (request.stage === "reconcile" && found.length !== replies.length)) {
    return retryInformationRequest({ ...updated, stage: "reconcile", status: "conflicted" }, now, "对端答复不一致，正在核对各方来源与当前版本，不能把冲突事实当作已解决。");
  }
  return { ...updated, status: "answered" as const, answer: found[0]!.answer, failureReason: undefined };
}

export function factFromRequest(request: InformationRequest, now = Date.now()): SharedFact | null {
  if (request.status !== "answered") return null;
  const latest = request.responses.filter(row => row.status === "found" && (row.attempt ?? 1) === (request.attempt ?? 1));
  if (!latest.length) return null;
  return { key: informationKey(request.question, request.key), question: request.question, value: latest[0]!.value ?? latest[0]!.answer,
    answer: request.answer ?? latest[0]!.answer, revision: request.revision, verifiedRevision: request.revision, status: "active", authority: "project", confirmedAt: new Date(now).toISOString(),
    validUntil: new Date(now + Math.min(...latest.map(row => row.validForSeconds ?? 3600)) * 1000).toISOString(), responses: latest };
}

export function administratorFact(request: InformationRequest, answer: string, now = Date.now()): SharedFact {
  return { key: informationKey(request.question, request.key), question: request.question, value: answer, answer, revision: request.revision, verifiedRevision: request.revision, status: "active", authority: "administrator", confirmedAt: new Date(now).toISOString(), validUntil: new Date(now + 3600_000).toISOString(),
    responses: [{ participantId: request.requestedByParticipantId, mode: "local", status: "found", answer, value: answer, attempt: 1, validForSeconds: 3600, sources: [{ scope: "shared_context", reference: `administrator-resolution:${request.id}`, finding: "管理员在该问题的处理入口提供的事实；未增加本机权限。", sourceVersion: new Date(now).toISOString() }] }] };
}
