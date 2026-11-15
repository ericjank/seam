import { describe, expect, it } from "vitest";
import { recoverySummary } from "../src/lib/recovery-summary";

describe("public recovery evidence", () => {
  it("exposes original turn evidence without forwarding private result fields", () => {
    const turnId = "01a1e00d-6b2e-7f12-8ea5-ff9ccc051fdc";
    const result = recoverySummary({ state: "interrupted", readOnly: true, turnId, recoveryKey: "private", reason: "private detail", workspace: { treeHash: "a".repeat(64), files: ["private"] }, observedCommandIds: ["one", "two"] });
    expect(result).toEqual({ state: "interrupted", readOnly: true, turnId, threadId: null, approvedHash: null, workspaceTreeHash: "a".repeat(64), observedCommandCount: 2 });
    expect(recoverySummary({ state: "unknown", recoveryKey: "private" })).toBeNull();
    expect(recoverySummary(null)).toBeNull();
  });
  it("does not present malformed identifiers as verified evidence", () => {
    expect(recoverySummary({ state: "unresolved", threadId: "unsafe", approvedHash: "unsafe" })).toMatchObject({ threadId: null, turnId: null, approvedHash: null, readOnly: false });
  });
});
