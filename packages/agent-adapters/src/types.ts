import type { AgentTurnResult, CollaborationContext } from "@seam/protocol";

export type AdapterType = "claude-code" | "codex" | "generic-cli" | "mock";
export type CodexSandbox = "read-only" | "workspace-write";

export interface AdapterOptions {
  /** Local owner setting. Never derive this from a platform job or agent output. */
  codexSandbox?: CodexSandbox;
}

export interface AgentRunInput {
  prompt?: string;
  context?: CollaborationContext;
  projectRoot: string;
  signal?: AbortSignal;
  localExecutionPolicy?: string;
}

export interface AgentAdapter {
  readonly type: AdapterType;
  run(input: AgentRunInput): Promise<AgentTurnResult>;
  healthCheck(projectRoot: string): Promise<{ ok: boolean; detail: string }>;
}
