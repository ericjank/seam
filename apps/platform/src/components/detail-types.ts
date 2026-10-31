import type { getCollaborationDetail } from "@/services/collaborations";

export type CollaborationData = Awaited<ReturnType<typeof getCollaborationDetail>>;
export type ActionRunner = (path: string, body?: unknown) => Promise<Record<string, any>>;
