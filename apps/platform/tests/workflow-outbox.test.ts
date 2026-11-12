import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: {} as Record<string, any[]> }));
vi.mock("@/db", () => ({ db: {
  select: () => {
    let table = "";
    const q: any = { from: (value: any) => { table = value[Symbol.for("drizzle:Name")]; return q; }, where: () => q, orderBy: () => q, limit: () => q,
      then: (resolve: any) => resolve((state.rows[table] ?? []).filter((row) => table !== "workflow_wakeups" || (!row.completedAt && row.availableAt <= new Date()))) };
    return q;
  },
  insert: (table: any) => ({ values: async (value: any) => { (state.rows[table[Symbol.for("drizzle:Name")]] ??= []).push({ attempts: 0, availableAt: new Date(), ...value }); } }),
  update: (table: any) => ({ set: (value: any) => ({ where: async () => { Object.assign(state.rows[table[Symbol.for("drizzle:Name")]]![0], value); } }) }),
} }));
vi.mock("@/services/agent-engine", () => ({ advanceAgentWorkflow: vi.fn(), dispatchAgentTurns: vi.fn() }));
import { advanceAgentWorkflow, dispatchAgentTurns } from "../src/services/agent-engine";
import { drainWorkflowWakeups, queueWorkflowWakeup } from "../src/services/workflow-outbox";

beforeEach(() => {
  vi.resetAllMocks();
  state.rows = { collaboration_lifecycles: [{ revision: 2, phase: "executing", documentHash: "current" }], collaborations: [{ createdById: "owner" }], participants: [{ collaborationId: "collab" }], workflow_wakeups: [] };
});

describe("持久化调度恢复", () => {
  it("提交后进程未调度，后续心跳可恢复；派发异常留存并重试", async () => {
    await queueWorkflowWakeup("collab", "completed-job");
    vi.mocked(advanceAgentWorkflow).mockRejectedValueOnce(new Error("server restart"));
    await drainWorkflowWakeups({ agentId: "agent" });
    const pending = state.rows.workflow_wakeups![0]!;
    expect(pending).toMatchObject({ attempts: 1, error: "server restart" });
    expect(pending.completedAt).toBeUndefined();
    pending.availableAt = new Date(0);
    await drainWorkflowWakeups({ agentId: "agent" });
    expect(advanceAgentWorkflow).toHaveBeenCalledTimes(2);
    expect(pending.completedAt).toBeInstanceOf(Date);
    await drainWorkflowWakeups({ agentId: "agent" });
    expect(advanceAgentWorkflow).toHaveBeenCalledTimes(2);
  });
  it("管理员批准落库后可自动补派发，旧修订和暂停记录不会重启实施", async () => {
    await queueWorkflowWakeup("collab");
    await drainWorkflowWakeups({ collaborationId: "collab" });
    expect(dispatchAgentTurns).toHaveBeenCalledWith("owner", "collab", undefined, { autoAdvance: true });
    state.rows.workflow_wakeups = [];
    await queueWorkflowWakeup("collab");
    state.rows.collaboration_lifecycles![0]!.revision = 3;
    await drainWorkflowWakeups({ collaborationId: "collab" });
    expect(dispatchAgentTurns).toHaveBeenCalledTimes(1);
    state.rows.workflow_wakeups = [];
    await queueWorkflowWakeup("collab");
    state.rows.collaboration_lifecycles![0]!.pausedAt = new Date();
    await drainWorkflowWakeups({ collaborationId: "collab" });
    expect(dispatchAgentTurns).toHaveBeenCalledTimes(1);
  });
});
