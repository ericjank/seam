import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: {} as Record<string, Record<string, any>[]>, role: "owner" }));

// Exercise the actual state machine and its persisted records. This tiny adapter
// interprets the equality/IN predicates used by this service, including upserts.
vi.mock("@/db", async () => {
  const { getTableColumns, getTableName } = await import("drizzle-orm");
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  const tableColumns: Record<string, Record<string, any>> = {};
  const nameOf = (table: any) => {
    const name = getTableName(table);
    tableColumns[name] = getTableColumns(table);
    return name;
  };
  const matches = (record: Record<string, any>, expression: any, base: string) => {
    if (!expression) return true;
    const { sql, params } = dialect.sqlToQuery(expression);
    let offset = 0;
    for (const match of sql.matchAll(/`([^`]+)`\.`([^`]+)` (?:= \?|in \(([^)]+)\))/g)) {
      const table = match[1]!, column = match[2]!, list = match[3];
      const property = Object.entries(tableColumns[table] ?? {}).find(([, value]) => value.name === column)?.[0];
      const row = table === base && !record.participant ? record : record[table === "participants" ? "participant" : table === "projects" ? "project" : "agent"];
      const count = list ? (list.match(/\?/g)?.length ?? 0) : 1;
      const accepted = params.slice(offset, offset + count);
      offset += count;
      if (!property || !accepted.includes(row?.[property])) return false;
    }
    return true;
  };
  const db = {
    select: () => {
      let table = "", expression: any, joined = false, limit = Infinity;
      const query: any = {
        from: (value: any) => { table = nameOf(value); return query; },
        where: (value: any) => { expression = value; return query; },
        innerJoin: (value: any) => { nameOf(value); joined = true; return query; },
        leftJoin: (value: any) => { nameOf(value); joined = true; return query; },
        orderBy: () => query, for: () => query,
        limit: (value: number) => { limit = value; return query; },
        then: (resolve: any, reject: any) => {
          const rows = (state.rows[table] ?? []).map((row) => joined ? {
            participant: row,
            project: state.rows.projects!.find((project) => project.id === row.projectId),
            agent: state.rows.agents!.find((agent) => agent.id === row.agentId) ?? null,
          } : row).filter((row) => matches(row, expression, table)).slice(0, limit);
          return Promise.resolve(rows.map((row) => structuredClone(row))).then(resolve, reject);
        },
      };
      return query;
    },
    insert: (value: any) => ({ values: (values: Record<string, any>) => {
      const table = nameOf(value);
      let duplicate: Record<string, any> | undefined;
      const query: any = {
        onDuplicateKeyUpdate: ({ set }: { set: Record<string, any> }) => { duplicate = set; return query; },
        then: (resolve: any, reject: any) => {
          const rows = state.rows[table] ?? (state.rows[table] = []);
          const existing = rows.find((row) => table === "lifecycle_contributions"
            ? row.collaborationId === values.collaborationId && row.revision === values.revision && row.participantId === values.participantId
            : table === "collaboration_lifecycles" ? row.collaborationId === values.collaborationId : row.id === values.id);
          if (existing && duplicate) Object.assign(existing, duplicate);
          else {
            const defaults = Object.fromEntries(Object.keys(tableColumns[table]!).map((key) => [key, null]));
            rows.push({ ...defaults, createdAt: new Date(), updatedAt: new Date(), ...structuredClone(values) });
          }
          return Promise.resolve([{ affectedRows: 1 }]).then(resolve, reject);
        },
      };
      return query;
    } }),
    update: (value: any) => ({ set: (values: Record<string, any>) => ({ where: async (expression: any) => {
      const table = nameOf(value);
      const rows = (state.rows[table] ?? []).filter((row) => matches(row, expression, table));
      rows.forEach((row) => Object.assign(row, structuredClone(values)));
      return [{ affectedRows: rows.length }];
    } }) }),
  };
  return { db, withTransaction: async (run: () => Promise<unknown>) => {
    const before = structuredClone(state.rows);
    try { return await run(); } catch (error) { state.rows = before; throw error; }
  } };
});
vi.mock("@/lib/access", () => ({ requireCollaborationAccess: vi.fn(async () => ({ role: state.role })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/services/actor", () => ({ authorizeActor: vi.fn(async (actor) => actor.kind === "participant" ? actor.id : null) }));

import {
  appendLifecycleRequirements, applyLifecycleAction, approveLifecycle, assertLifecycleJobCurrent,
  getLifecycleContext, getLifecycleSnapshot, startLifecycle, terminateLifecycle,
} from "../src/services/lifecycle";

const actor = (id: string) => ({ kind: "participant" as const, id });
const plan = (side: string) => `## ${side} 实施方案\n\n${"检查仓库现状，确认接口责任、开发步骤、测试与实际证据；未经管理员确认不得执行修改。".repeat(4)}`;
const submit = (id: string, revision = 1, content = plan(id)) => applyLifecycleAction(actor(id), "collab", { type: "plan.submit", revision, content });
const report = (id: string, revision = 1, status: "passed" | "failed" = "passed") => applyLifecycleAction(actor(id), "collab", { type: "execution.report", revision, status, summary: `${id} 完成代码和测试；${status}`, evidence: { tests: status, commands: ["pnpm test"] } });
async function agreed(revision = 1) {
  await submit("a", revision); await submit("b", revision);
  const context = (await getLifecycleContext("collab"))!;
  for (const id of ["a", "b"]) await applyLifecycleAction(actor(id), "collab", { type: "plan.confirm", revision, documentHash: context.documentHash! });
  return (await getLifecycleContext("collab"))!;
}
async function approved(revision = 1) {
  const context = await agreed(revision);
  return approveLifecycle("admin", "collab", { revision, documentHash: context.documentHash! });
}

beforeEach(() => {
  state.role = "owner";
  state.rows = {
    collaborations: [{ id: "collab", title: "双端共同开发", objective: "减少表单，让双方 AI 协商并实施接口联调", status: "draft" }],
    participants: ["a", "b"].map((id) => ({ id, collaborationId: "collab", projectId: `project-${id}`, agentId: `agent-${id}`, role: "participant", status: "active", createdAt: new Date() })),
    projects: ["a", "b"].map((id) => ({ id: `project-${id}`, name: `项目 ${id}` })),
    agents: ["a", "b"].map((id) => ({ id: `agent-${id}`, status: "online", lastSeenAt: new Date() })),
    collaboration_lifecycles: [], lifecycle_revisions: [], lifecycle_contributions: [], messages: [], connector_jobs: [],
  };
  vi.clearAllMocks();
});

describe("管理员控制的共同开发生命周期", () => {
  it("完整闭环：同版双确认、人工批准、双端报告、追加新版本、人工终止", async () => {
    expect((await startLifecycle("admin", "collab")).phase).toBe("planning");
    const approval = await approved();
    expect(approval.phase).toBe("executing");
    expect(approval.approvedHash).toBe(approval.documentHash);
    await report("a");
    expect((await getLifecycleContext("collab"))!.phase).toBe("executing");
    await report("b");
    const reviewed = (await getLifecycleContext("collab"))!;
    expect(reviewed.phase).toBe("awaiting_review");
    expect(reviewed.report).toContain("项目 a");
    expect(reviewed.report).toContain("项目 b");
    expect(state.rows.collaborations![0]!.status).toBe("validating");
    const next = await appendLifecycleRequirements("admin", "collab", { requirements: "增加幂等重试与回归验证" });
    expect(next).toMatchObject({ revision: 2, phase: "planning", document: null, approvedHash: null, confirmations: [], reports: [] });
    expect(next.requirements).toContain("增加幂等重试与回归验证");
    expect(state.rows.lifecycle_revisions![0]!.report).toBe(reviewed.report);
    await approved(2); await report("a", 2); await report("b", 2);
    expect((await terminateLifecycle("admin", "collab", { revision: 2 })).phase).toBe("terminated");
    expect(state.rows.collaborations![0]!.status).toBe("completed");
  });

  it("不能绕过管理员、同版确认或内容哈希", async () => {
    await startLifecycle("admin", "collab");
    await expect(report("a")).rejects.toMatchObject({ status: 409 });
    await expect(applyLifecycleAction({ kind: "user", id: "admin" }, "collab", { type: "plan.submit", revision: 1, content: plan("user") })).rejects.toMatchObject({ status: 403 });
    await submit("a"); await submit("b");
    const current = (await getLifecycleContext("collab"))!;
    await expect(approveLifecycle("admin", "collab", { revision: 1, documentHash: current.documentHash! })).rejects.toMatchObject({ status: 409 });
    await applyLifecycleAction(actor("a"), "collab", { type: "plan.confirm", revision: 1, documentHash: current.documentHash! });
    await expect(applyLifecycleAction(actor("b"), "collab", { type: "plan.confirm", revision: 1, documentHash: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    await applyLifecycleAction(actor("b"), "collab", { type: "plan.confirm", revision: 1, documentHash: current.documentHash! });
    state.role = "member";
    await expect(approveLifecycle("member", "collab", { revision: 1, documentHash: current.documentHash! })).rejects.toMatchObject({ status: 403 });
    state.role = "owner";
    await expect(approveLifecycle("admin", "collab", { revision: 1, documentHash: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect((await getLifecycleContext("collab"))!.phase).toBe("awaiting_approval");
  });

  it("协商中修改方案会作废旧内容确认，旧任务及旧 hash 被拒绝", async () => {
    await startLifecycle("admin", "collab");
    await submit("a"); await submit("b");
    const before = (await getLifecycleContext("collab"))!;
    const snapshot = await getLifecycleSnapshot("collab");
    await applyLifecycleAction(actor("a"), "collab", { type: "plan.confirm", revision: 1, documentHash: before.documentHash! });
    await submit("b", 1, `${plan("b")}\n\n解决另一方提出的接口冲突`);
    const after = (await getLifecycleContext("collab"))!;
    expect(after.documentHash).not.toBe(before.documentHash);
    expect(after.confirmations).toEqual([]);
    await expect(assertLifecycleJobCurrent("collab", snapshot)).rejects.toMatchObject({ status: 409 });
    await expect(applyLifecycleAction(actor("b"), "collab", { type: "plan.confirm", revision: 1, documentHash: before.documentHash! })).rejects.toMatchObject({ status: 409 });
  });

  it("同批最后确认的快照可回执；旧修订及执行中的追加/终止被拒绝", async () => {
    await startLifecycle("admin", "collab");
    await submit("a"); await submit("b");
    const snapshot = await getLifecycleSnapshot("collab");
    const context = (await getLifecycleContext("collab"))!;
    for (const id of ["a", "b"]) await applyLifecycleAction(actor(id), "collab", { type: "plan.confirm", revision: 1, documentHash: context.documentHash! });
    await expect(assertLifecycleJobCurrent("collab", snapshot)).resolves.toMatchObject({ phase: "awaiting_approval" });
    await approveLifecycle("admin", "collab", { revision: 1, documentHash: context.documentHash! });
    await expect(appendLifecycleRequirements("admin", "collab", { requirements: "打断开发" })).rejects.toMatchObject({ status: 409 });
    await expect(terminateLifecycle("admin", "collab")).rejects.toMatchObject({ status: 409 });
    await report("a"); await report("b");
    await appendLifecycleRequirements("admin", "collab", { requirements: "新的要求" });
    await expect(report("a")).rejects.toMatchObject({ status: 409 });
    await expect(assertLifecycleJobCurrent("collab", snapshot)).rejects.toMatchObject({ status: 409 });
  });

  it("失败报告保留真实状态，收齐后仍待管理员审阅且不会自动终止", async () => {
    await startLifecycle("admin", "collab"); await approved();
    await report("a", 1, "failed"); await report("b");
    const context = (await getLifecycleContext("collab"))!;
    expect(context.phase).toBe("awaiting_review");
    expect(context.reports.find((item) => item.participantId === "a")?.status).toBe("failed");
    expect(context.report).toContain("存在失败或阻塞");
    expect(state.rows.collaborations![0]!.status).toBe("validating");
  });

  it("离线或缺少双方 Agent 不能开始；普通成员不能开始", async () => {
    state.rows.agents![0]!.lastSeenAt = new Date(0);
    await expect(startLifecycle("admin", "collab")).rejects.toMatchObject({ status: 409 });
    expect(await getLifecycleContext("collab")).toBeNull();
    state.rows.agents![0]!.lastSeenAt = new Date();
    state.role = "member";
    await expect(startLifecycle("member", "collab")).rejects.toMatchObject({ status: 403 });
  });
});
