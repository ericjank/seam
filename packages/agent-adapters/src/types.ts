import type { AgentTurnResult, CollaborationContext } from "@seam/protocol";

export type AdapterType = "claude-code" | "codex" | "generic-cli" | "mock";

export interface AgentRunInput {
  prompt?: string;
  context?: CollaborationContext;
  projectRoot: string;
  signal?: AbortSignal;
}

export interface AgentAdapter {
  readonly type: AdapterType;
  run(input: AgentRunInput): Promise<AgentTurnResult>;
  healthCheck(projectRoot: string): Promise<{ ok: boolean; detail: string }>;
}
