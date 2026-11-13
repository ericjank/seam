import { type InformationRequest, type LifecycleAgentAction } from "@seam/protocol";
import { HttpError } from "./http";

export const MAX_INFORMATION_REQUESTS = 3;
type Source = InformationRequest["responses"][number]["sources"][number];

export function validateInformationSources(sources: Source[], localSearch = false) {
  if (sources.some(source => source.scope === "local_project" && (/^(?:\/|~[\\/]|[A-Za-z]:[\\/]|file:)/.test(source.reference.trim())
    || /(?:^|[\\/])(?:\.\.|\.env(?:\..*)?|id_rsa|id_ed25519|credentials)(?:$|[\\/])/.test(source.reference)))) throw new HttpError(422, "只引用相对项目资料，不得查找或分享本机秘密文件");
  if (localSearch && (!["local_project", "shared_context"].every(scope => sources.some(source => source.scope === scope)))) throw new HttpError(422, "转询对端前必须记录本地项目与共享资料的检索结果");
}

export function openInformationRequest(input: {
  requests: InformationRequest[]; id: string; revision: number; phase: string; participantId: string;
  requiredParticipantIds: string[]; question: string; searched?: Source[]; now: string;
}) {
  if (input.searched) validateInformationSources(input.searched, true);
  const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const duplicate = input.requests.find(row => row.status === "pending" && row.revision === input.revision && row.phase === input.phase
    && row.requestedByParticipantId === input.participantId && normalized(row.question) === normalized(input.question));
  if (duplicate) return { requests: input.requests, request: duplicate };
  if (input.requests.filter(row => row.revision === input.revision && row.requestedByParticipantId === input.participantId).length >= MAX_INFORMATION_REQUESTS) return { requests: input.requests, request: null };
  const request: InformationRequest = {
    id: input.id, revision: input.revision, phase: input.phase, question: input.question,
    requestedByParticipantId: input.participantId, targetParticipantIds: input.requiredParticipantIds.filter(id => id !== input.participantId),
    stage: input.searched ? "peer" : "local", status: "pending", answer: null, createdAt: input.now,
    responses: input.searched ? [{ participantId: input.participantId, mode: "local", status: "unavailable", answer: "本地与共享资料未解决该问题，向对端询证。", sources: input.searched }] : [],
  };
  return { requests: [...input.requests, request], request };
}

export function answerInformationRequest(request: InformationRequest, participantId: string,
  action: Extract<LifecycleAgentAction, { type: "information.respond" }>, phase: string) {
  if (request.status !== "pending" || request.revision !== action.revision || request.phase !== phase) throw new HttpError(409, "信息请求已失效或已处理");
  const mode = request.stage;
  if (mode === "local" ? request.requestedByParticipantId !== participantId : !request.targetParticipantIds.includes(participantId)) throw new HttpError(403, "只能处理分配给本方的信息查找任务");
  if (request.responses.some(row => row.mode === mode && row.participantId === participantId)) throw new HttpError(409, "本方已答复此信息请求");
  validateInformationSources(action.sources, mode === "local" && action.status === "unavailable");
  if (mode === "peer" && action.status === "unavailable" && !action.sources.some(source => source.scope === "local_project")) throw new HttpError(422, "对端无法答复时必须记录本方项目资料的检索来源");
  const updated = { ...request, responses: [...request.responses, { participantId, mode, status: action.status, answer: action.answer, sources: action.sources }] };
  if (mode === "local") {
    if (action.status === "found") return { ...updated, status: "answered" as const, answer: action.answer };
    return { ...updated, stage: "peer" as const };
  }
  if (!request.targetParticipantIds.every(id => updated.responses.some(row => row.mode === "peer" && row.participantId === id))) return updated;
  const found = updated.responses.filter(row => row.status === "found");
  return { ...updated, status: found.length ? "answered" as const : "needs_admin" as const,
    answer: found.length === 1 ? found[0]!.answer : found.length ? `已收集 ${found.length} 份对端答复，请核对下方原文与来源。` : null };
}

