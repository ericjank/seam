/** Public recovery evidence; never forward the journal, credentials or raw result. */
export function recoverySummary(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!["completed", "interrupted", "unresolved"].includes(String(record.state))) return null;
  const id = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value) ? value : null;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
  const workspace = record.workspace as { treeHash?: unknown } | null;
  return {
    state: record.state as "completed" | "interrupted" | "unresolved",
    readOnly: record.readOnly === true,
    threadId: id(record.threadId), turnId: id(record.turnId),
    approvedHash: hash(record.approvedHash), workspaceTreeHash: hash(workspace?.treeHash),
    observedCommandCount: Array.isArray(record.observedCommandIds) ? record.observedCommandIds.length : 0,
  };
}
