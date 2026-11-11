import type { AdapterOptions, AgentRunInput, CodexSandbox } from "./types.js";

/** Authorization comes from typed lifecycle state, never from free-form text. */
export function codexSandboxForTurn(input: AgentRunInput, options: AdapterOptions = {}): CodexSandbox {
  const lifecycle = input.context && "lifecycle" in input.context ? input.context.lifecycle : null;
  if (options.codexSandbox !== "workspace-write" || !lifecycle || typeof lifecycle !== "object") return "read-only";
  const state = lifecycle as Record<string, unknown>;
  return state.phase === "executing" && typeof state.documentHash === "string" && /^[a-f0-9]{64}$/i.test(state.documentHash)
    && state.approvedHash === state.documentHash ? "workspace-write" : "read-only";
}

export function codexNetworkForTurn(input: AgentRunInput, options: AdapterOptions = {}) {
  return options.codexNetworkAccess === true && codexSandboxForTurn(input, options) === "workspace-write";
}
