import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as any[][],
  updates: [] as Record<string, any>[],
  inserts: [] as any[],
}));
vi.mock("@/db", () => ({
  db: {
    select: () => {
      const query: Record<string, any> = {};
      let tableName = "";
      query.from = (table: any) => { tableName = table[Symbol.for("drizzle:Name")]; return query; };
      for (const method of ["where", "limit", "orderBy", "for"]) query[method] = () => query;
      query.then = (resolve: (rows: any[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(tableName === "collaborations" ? [{ id: "collaboration" }] : state.queries.shift() ?? []).then(resolve, reject);
      return query;
    },
    update: () => ({ set: (values: Record<string, any>) => ({ where: async () => { state.updates.push(values); } }) }),
    insert: () => ({ values: async (values: any) => { state.inserts.push(values); } }),
  },
  withTransaction: async (run: () => Promise<unknown>) => {
    const counts = [state.updates.length, state.inserts.length];
    try { return await run(); }
    catch (error) { state.updates.splice(counts[0]!); state.inserts.splice(counts[1]!); throw error; }
  },
}));
vi.mock("@/services/actor", () => ({ authorizeActor: vi.fn(async (): Promise<string | null> => "participant") }));
vi.mock("@/services/collaborations", () => ({ addSystemMessage: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { submitAcceptance } from "../src/services/acceptance";
import { authorizeActor } from "../src/services/actor";

const actor = { kind: "participant" as const, id: "participant" };
const work = { id: "work", collaborationId: "collaboration", status: "validating", title: "开发", assigneeParticipantId: "participant" };
const passed = { workItemId: "work", status: "passed" as const, summary: "合成接口测试通过", evidence: { passed: 3 } };

beforeEach(() => {
  state.queries = []; state.updates = []; state.inserts = [];
  vi.clearAllMocks();
  vi.mocked(authorizeActor).mockResolvedValue("participant");
});

describe("真实验收与工作任务约束", () => {
  it("不能把另一个协作的任务标为验收通过", async () => {
    state.queries.push([]);
    await expect(submitAcceptance(actor, "collaboration", passed)).rejects.toMatchObject({ status: 404 });
    expect(state.inserts).toEqual([]);
  });

  it("不能代替另一个负责项目提交任务验收", async () => {
    state.queries.push([{ ...work, assigneeParticipantId: "other" }]);
    await expect(submitAcceptance(actor, "collaboration", passed)).rejects.toMatchObject({ status: 403 });
    expect(state.updates).toEqual([]);
  });

  it("通过验收也不能跳过未完成的前置任务", async () => {
    state.queries.push([work], [{ dependsOnId: "deploy" }], [{ id: "deploy", title: "部署核验", status: "blocked" }]);
    await expect(submitAcceptance(actor, "collaboration", passed)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("部署核验") });
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("所有任务完成且有本项目最新通过证据时协作才能完成", async () => {
    state.queries.push([work], [], [{ ...work, status: "completed" }], [{ ...passed, participantId: "participant" }]);
    await submitAcceptance(actor, "collaboration", passed);
    expect(state.inserts).toEqual([expect.objectContaining({ workItemId: "work", participantId: "participant", status: "passed" })]);
    expect(state.updates.map((update) => update.status)).toEqual(["completed", "validating", "completed"]);
  });

  it("其他任务只有 completed 状态而缺少证据时协作仍未完成", async () => {
    state.queries.push([work], [], [{ ...work, status: "completed" }, { ...work, id: "other", status: "completed" }], [{ ...passed, participantId: "participant" }]);
    await submitAcceptance(actor, "collaboration", passed);
    expect(state.updates.map((update) => update.status)).toEqual(["completed", "validating"]);
  });

  it("最新失败证据不能被旧通过证据覆盖", async () => {
    state.queries.push([{ ...work, status: "completed" }], [
      { ...passed, participantId: "participant", status: "failed" },
      { ...passed, participantId: "participant" },
    ]);
    await submitAcceptance(actor, "collaboration", { status: "passed", summary: "补充一般测试报告" });
    expect(state.updates.map((update) => update.status)).toEqual(["validating"]);
  });

  it("失败证据允许记录在blocked任务，不伪造in_progress或完成", async () => {
    state.queries.push([{ ...work, status: "blocked" }], [{ ...work, status: "blocked" }]);
    await submitAcceptance(actor, "collaboration", { ...passed, status: "failed", summary: "部署前置尚未满足" });
    expect(state.inserts.at(-1)?.status).toBe("failed");
    expect(state.updates.map((update) => update.status)).toEqual(["validating"]);
  });

  it("验收产物必须属于同一协作", async () => {
    state.queries.push([]);
    await expect(submitAcceptance(actor, "collaboration", { status: "passed", summary: "结果", artifactId: "foreign" }))
      .rejects.toMatchObject({ status: 404 });
    expect(state.inserts).toEqual([]);
  });

  it("产物缺少当前版本时拒绝验收且回滚已写任务状态", async () => {
    state.queries.push([work], [], [{ id: "artifact", currentVersion: 2 }], []);
    await expect(submitAcceptance(actor, "collaboration", { ...passed, artifactId: "artifact" })).rejects.toMatchObject({ status: 409 });
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("以用户身份而无明确项目时不能产生项目验收证据", async () => {
    vi.mocked(authorizeActor).mockResolvedValueOnce(null);
    await expect(submitAcceptance({ kind: "user", id: "user" }, "collaboration", passed)).rejects.toMatchObject({ status: 422 });
  });
});
