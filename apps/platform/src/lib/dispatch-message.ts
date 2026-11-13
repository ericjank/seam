export type DispatchTarget = { jobId: string; participantId: string; projectId: string; projectName: string; agentId: string; agentName: string };
export type Dispatch = { workflowId: string; round: number; maxRounds: number; targets: DispatchTarget[] };
export type DispatchJob = DispatchTarget & { workflowId: string; round: number; maxRounds: number; createdAt: Date };
type Message = { authorType: string; body: string; metadata: unknown; createdAt: Date };
const legacyDispatch = /^已向 (\d+) 个项目 Agent 派发本次第 (\d+)\/(\d+) 批协作。$/;

export function dispatchRecipient(target: { projectName: string; agentName: string }) {
  return `项目「${target.projectName}」 · Agent「${target.agentName}」`;
}

export function dispatchMessage(dispatch: Dispatch) {
  return `已派发本次第 ${dispatch.round}/${dispatch.maxRounds} 批协作。\n接收方：\n${dispatch.targets.map(target => `• ${dispatchRecipient(target)}`).join("\n")}`;
}

export const hasLegacyDispatch = (messages: Message[]) => messages.some(message => message.authorType === "system" && legacyDispatch.test(message.body));

/** Reconstruct display only when the entire ordered dispatch history matches actual job batches. */
export function recoverDispatchNames<T extends Message>(messages: T[], jobs: DispatchJob[]): T[] {
  const dispatches = messages.filter(message => message.authorType === "system" && (legacyDispatch.test(message.body) || (message.metadata as { dispatch?: Dispatch } | null)?.dispatch));
  const groups = new Map<string, DispatchJob[]>();
  for (const job of jobs) {
    if (!job.workflowId || !job.participantId || !job.projectId || !job.agentId || !job.projectName || !job.agentName || !Number.isInteger(job.round) || !Number.isInteger(job.maxRounds)) return messages;
    const key = `${job.workflowId}:${job.round}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const batches = [...groups.values()];
  if (batches.length !== dispatches.length) return messages;
  const recovered = new Map<T, Dispatch>();
  for (const [index, message] of dispatches.entries()) {
    const batch = batches[index]!, first = batch[0]!;
    const old = legacyDispatch.exec(message.body), stored = (message.metadata as { dispatch?: Dispatch } | null)?.dispatch;
    if (stored && !Array.isArray(stored.targets)) return messages;
    const round = old ? Number(old[2]) : stored?.round, maxRounds = old ? Number(old[3]) : stored?.maxRounds;
    const count = old ? Number(old[1]) : stored?.targets.length;
    if (count !== batch.length || round !== first.round || maxRounds !== first.maxRounds || batch.some(job => job.createdAt > message.createdAt)) return messages;
    if (stored && (stored.workflowId !== first.workflowId || stored.targets.some((target, position) => target.jobId !== batch[position]?.jobId))) return messages;
    if (old) recovered.set(message, { workflowId: first.workflowId, round: first.round, maxRounds: first.maxRounds,
      targets: batch.map(({ jobId, participantId, projectId, projectName, agentId, agentName }) => ({ jobId, participantId, projectId, projectName, agentId, agentName })) });
  }
  return messages.map(message => {
    const dispatch = recovered.get(message);
    return dispatch ? { ...message, body: dispatchMessage(dispatch), metadata: { ...(message.metadata as Record<string, unknown>), dispatch, dispatchRecoveredFromJobs: true } } : message;
  });
}
