import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as any[][],
  updates: [] as Record<string, any>[],
  inserts: [] as any[],
  effects: [] as string[],
  affected: [] as number[],
  transactions: [] as boolean[],
  lastRows: {} as Record<string, any[]>,
  apply: null as (() => Promise<void>) | null,
}));

vi.mock("@/db", () => ({
  db: {
    select: () => {
      const query: Record<string, any> = {};
      let tableName = "";
      let locked = false;
      for (const method of ["where", "limit", "orderBy"]) query[method] = () => query;
      query.from = (table: any) => { tableName = table[Symbol.for("drizzle:Name")]; return query; };
      query.for = () => { locked = true; return query; };
      query.then = (resolve: (rows: any[]) => unknown, reject: (reason: unknown) => unknown) => {
        const rows = tableName === "collaborations" ? [{ id: "collaboration" }] :
          locked && state.lastRows[tableName] ? state.lastRows[tableName]! : state.queries.shift() ?? [];
        state.lastRows[tableName] = rows;
        return Promise.resolve(rows).then(resolve, reject);
      };
      return query;
    },
    update: () => ({ set: (values: Record<string, any>) => ({ where: async () => {
      state.updates.push(values);
      return [{ affectedRows: state.affected.shift() ?? 1 }];
    } }) }),
    insert: () => ({ values: async (values: any) => { state.inserts.push(values); } }),
  },
  withTransaction: async (run: () => Promise<unknown>, options: { savepoint?: boolean } = {}) => {
    state.transactions.push(!!options.savepoint);
    const effects = [...state.effects];
    const updateCount = state.updates.length;
    const insertCount = state.inserts.length;
    try { return await run(); }
    catch (error) {
      state.effects = effects;
      state.updates.splice(updateCount);
      state.inserts.splice(insertCount);
      throw error;
    }
  },
}));
vi.mock("@/services/agent-engine", () => ({
  completeAgentTurn: vi.fn(async () => { await state.apply?.(); }),
  advanceAgentWorkflow: vi.fn(async () => {}),
  refreshAgentJobContext: vi.fn(async (job) => job.payload),
}));
vi.mock("@/services/acceptance", () => ({ submitAcceptance: vi.fn() }));
vi.mock("@/services/actor", () => ({ authorizeActor: vi.fn(async () => "participant") }));
vi.mock("@/services/collaborations", () => ({ addSystemMessage: vi.fn() }));

import { completeConnectorJob, pollConnectorJob } from "../src/services/connectors";
import { advanceAgentWorkflow, completeAgentTurn, refreshAgentJobContext } from "../src/services/agent-engine";
import { createWorkItem, updateWorkItem } from "../src/services/work-items";
import { submitAcceptance } from "../src/services/acceptance";
import { addSystemMessage } from "../src/services/collaborations";
import { HttpError, handleApiError } from "../src/lib/http";

const job = (extra = {}) => ({
  id: "job", agentId: "agent", collaborationId: "collaboration", kind: "collaboration.turn", status: "running",
  attempts: 1, leaseUntil: new Date(Date.now() + 60_000), payload: { context: {} }, ...extra,
});
const actor = { kind: "user" as const, id: "user" };

beforeEach(() => {
  state.queries = []; state.updates = []; state.inserts = []; state.effects = [];
  state.affected = []; state.transactions = []; state.apply = null;
  state.lastRows = {};
  vi.clearAllMocks();
  vi.mocked(advanceAgentWorkflow).mockResolvedValue(undefined);
  vi.mocked(refreshAgentJobContext).mockImplementation(async (job) => job.payload);
});

describe("Connector 结果与任务领取", () => {
  it("动作应用完成后才记录 completed，提交后才继续派发", async () => {
    state.queries.push([job()]);
    state.apply = async () => {
      expect(state.updates.some((update) => update.status === "completed")).toBe(false);
      state.effects.push("artifact");
    };
    await completeConnectorJob("agent", { jobId: "job", status: "completed", result: { agentTurn: {} }, attempts: 1 });
    expect(state.effects).toEqual(["artifact"]);
    expect(state.updates.at(-1)?.status).toBe("completed");
    expect(state.transactions).toEqual([false, true]);
    expect(advanceAgentWorkflow).toHaveBeenCalledOnce();
  });

  it("任一动作失败回滚前面的动作，并保留 failed 回执", async () => {
    state.queries.push([job()]);
    state.apply = async () => { state.effects.push("partial artifact"); throw new HttpError(409, "前置任务未完成：部署核验"); };
    await expect(completeConnectorJob("agent", { jobId: "job", status: "completed", result: {} }))
      .rejects.toMatchObject({ status: 409, message: "前置任务未完成：部署核验" });
    expect(state.effects).toEqual([]);
    expect(state.updates).toEqual([expect.objectContaining({ status: "failed", result: null, error: "前置任务未完成：部署核验" })]);
    expect(advanceAgentWorkflow).toHaveBeenCalledOnce();
  });

  it("重复完成回传不能重复应用动作", async () => {
    state.queries.push([job({ status: "completed" })]);
    await expect(completeConnectorJob("agent", { jobId: "job", status: "completed", result: {} })).rejects.toMatchObject({ status: 409 });
    expect(completeAgentTurn).not.toHaveBeenCalled();
  });

  it.each([
    { leaseUntil: new Date(0), attempts: 1, submitted: 1 },
    { leaseUntil: new Date(Date.now() + 60_000), attempts: 2, submitted: 1 },
    { leaseUntil: new Date(Date.now() + 60_000), attempts: 2, submitted: undefined },
  ])("拒绝过期租约和重领前的旧 worker $attempts/$submitted", async ({ submitted, ...extra }) => {
    state.queries.push([job(extra)]);
    await expect(completeConnectorJob("agent", { jobId: "job", status: "completed", attempts: submitted })).rejects.toMatchObject({ status: 409 });
    expect(completeAgentTurn).not.toHaveBeenCalled();
  });

  it("重新领取的 worker 携带当前 attempts 可正常完成", async () => {
    state.queries.push([job({ attempts: 2 })]);
    await completeConnectorJob("agent", { jobId: "job", status: "completed", attempts: 2, result: {} });
    expect(completeAgentTurn).toHaveBeenCalledOnce();
  });

  it("后续派发失败不会把已应用动作改为 failed 或抛出让 Connector 重放", async () => {
    state.queries.push([job()]);
    vi.mocked(advanceAgentWorkflow).mockRejectedValueOnce(new Error("schedule unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await completeConnectorJob("agent", { jobId: "job", status: "completed", result: {} });
    expect(state.updates.at(-1)?.status).toBe("completed");
    expect(log).toHaveBeenCalledOnce();
    expect(addSystemMessage).toHaveBeenCalledWith("collaboration", expect.stringContaining("点击继续推进重试"));
    log.mockRestore();
  });

  it("不合规的本地测试不会写入验收或被标 completed", async () => {
    state.queries.push([job({ kind: "local.test", payload: { participantId: "ea021660-ad66-4d02-b782-3d82fb18c1bb" } })]);
    await expect(completeConnectorJob("agent", { jobId: "job", status: "completed", result: { testRun: { status: "passed" } } }))
      .rejects.toMatchObject({ status: 422 });
    expect(submitAcceptance).not.toHaveBeenCalled();
    expect(state.updates.at(-1)?.status).toBe("failed");
  });

  it("兼容旧本地测试任务的空关联字段", async () => {
    state.queries.push([job({ kind: "local.test", payload: {
      participantId: "ea021660-ad66-4d02-b782-3d82fb18c1bb", workItemId: null, artifactId: null,
    } })]);
    await completeConnectorJob("agent", { jobId: "job", status: "completed", result: { testRun: { status: "passed", summary: "本地合成测试通过" } } });
    expect(submitAcceptance).toHaveBeenCalledWith(expect.anything(), "collaboration", expect.objectContaining({
      workItemId: undefined, artifactId: undefined, status: "passed",
    }));
    expect(state.updates.at(-1)?.status).toBe("completed");
  });

  it("Connector 失败回执也触发调度核对，使期间的新指令有机会继续", async () => {
    state.queries.push([job()]);
    await completeConnectorJob("agent", { jobId: "job", status: "failed", error: "CLI 无法执行" });
    expect(state.updates.at(-1)).toMatchObject({ status: "failed", error: "CLI 无法执行", result: null });
    expect(completeAgentTurn).not.toHaveBeenCalled();
    expect(advanceAgentWorkflow).toHaveBeenCalledOnce();
  });

  it("领取竞争失败的 worker 不会返回另一个 worker 已领取的任务", async () => {
    state.queries.push([job({ status: "pending" })]);
    state.affected.push(1, 1, 0); // heartbeat, expiry reset, lost claim
    expect(await pollConnectorJob("agent", 0)).toBeNull();
    expect(refreshAgentJobContext).not.toHaveBeenCalled();
  });

  it("返回领取时刷新后的最新上下文，并保存到任务", async () => {
    state.queries.push([job({ status: "pending" })], [job()]);
    vi.mocked(refreshAgentJobContext).mockResolvedValueOnce({ context: { objective: "latest" } });
    const claimed = await pollConnectorJob("agent", 0);
    expect(claimed?.payload).toEqual({ context: { objective: "latest" } });
    expect(state.updates.at(-1)?.payload).toEqual(claimed?.payload);
  });

  it("无法刷新上下文时保留清晰的 failed 回执而不执行旧任务", async () => {
    state.queries.push([job({ status: "pending" })], [job()]);
    vi.mocked(refreshAgentJobContext).mockRejectedValueOnce(new HttpError(409, "参与方已退出"));
    await expect(pollConnectorJob("agent", 0)).rejects.toMatchObject({ status: 409, message: "参与方已退出" });
    expect(state.updates.at(-1)).toMatchObject({ status: "failed", error: "参与方已退出", leaseUntil: null });
    expect(advanceAgentWorkflow).toHaveBeenCalledWith("job");
  });
});

describe("工作任务约束反馈", () => {
  it("依赖阻塞返回409及具体任务，不能误报为服务器500", async () => {
    state.queries.push([{ id: "work", collaborationId: "collaboration", title: "开发", status: "pending" }], [{ dependsOnId: "deploy" }], [{ id: "deploy", title: "部署核验", status: "blocked" }]);
    try {
      await updateWorkItem(actor, "work", { status: "in_progress" });
      throw new Error("expected dependency error");
    } catch (error) {
      expect(error).toMatchObject({ status: 409 });
      const response = handleApiError(error);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("部署核验") } });
    }
    expect(state.updates).toEqual([]);
  });

  it("状态更新不能代替验收直接标为 completed", async () => {
    state.queries.push([{ id: "work", collaborationId: "collaboration", status: "pending" }], [{ dependsOnId: "deploy" }], [{ id: "deploy", title: "部署", status: "pending" }]);
    await expect(updateWorkItem(actor, "work", { status: "completed" })).rejects.toMatchObject({ status: 422 });
  });

  it("相同状态仅回报摘要不算状态推进", async () => {
    state.queries.push([{ id: "work", collaborationId: "collaboration", status: "in_progress" }]);
    expect(await updateWorkItem(actor, "work", { status: "in_progress", summary: "仍在开发" })).toEqual({ changed: false });
    expect(state.updates).toEqual([]);
  });

  it("API 路径所属协作与任务不符时拒绝更新", async () => {
    state.queries.push([{ id: "work", collaborationId: "other", status: "pending" }]);
    await expect(updateWorkItem(actor, "work", { status: "in_progress" }, "collaboration")).rejects.toMatchObject({ status: 404 });
  });

  it("跨协作或不存在的依赖在写入前被拒绝", async () => {
    state.queries.push([]);
    await expect(createWorkItem(actor, "collaboration", { title: "开发", dependsOn: ["foreign"] })).rejects.toMatchObject({ status: 422 });
    expect(state.inserts).toEqual([]);
  });

  it("任务负责人必须是该协作有效参与方", async () => {
    state.queries.push([]);
    await expect(createWorkItem(actor, "collaboration", { title: "开发", assigneeParticipantId: "foreign" })).rejects.toMatchObject({ status: 422 });
    expect(state.inserts).toEqual([]);
  });
});
