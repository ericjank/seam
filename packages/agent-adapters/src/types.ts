import type { AgentTurnResult, CollaborationContext } from "@seam/protocol";

export type AdapterType = "claude-code" | "codex" | "codex-app-server" | "generic-cli" | "mock";
export type CodexSandbox = "read-only" | "workspace-write";

export interface AdapterOptions {
  /** Local owner setting. Never derive this from a platform job or agent output. */
  codexSandbox?: CodexSandbox;
  appServerStateDir?: string;
  codexNetworkAccess?: boolean;
}

export interface AgentRunInput {
  prompt?: string;
  context?: CollaborationContext;
  projectRoot: string;
  signal?: AbortSignal;
  localExecutionPolicy?: string;
  conversationMode?: "persistent" | "independent";
  /** Hash of the claimed job payload, computed by Connector outside model text. */
  jobPayloadHash?: string;
  /** A locally verified checkpoint from this approved revision, never model supplied. */
  resuming?: boolean;
  resources?: Array<{ key: string; path: string; hash: string; bytes: number }>;
  onCommand?: (record: { id: string; command: string; exitCode: number | null; output: string }) => void;
}

export interface AgentAdapter {
  readonly type: AdapterType;
  run(input: AgentRunInput): Promise<AgentTurnResult>;
  healthCheck(projectRoot: string): Promise<{ ok: boolean; detail: string }>;
  /** Actual local transport metadata, never supplied by model-generated text. */
  getConversation?(input: AgentRunInput): Promise<{ threadId: string; transport: "codex-app-server" } | null>;
}
