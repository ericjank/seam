import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import * as schema from "../src/db/schema";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, any[]>,
  orders: [] as { table: string; sql: string }[],
  updates: [] as { table: string; values: any }[],
}));

vi.mock("@/db", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  const nameOf = (table: any) => table[Symbol.for("drizzle:Name")] as string;
  const filter = (table: string, rows: any[], condition: any) => {
    if (!condition) return rows;
    const { sql, params } = dialect.sqlToQuery(condition);
    if (sql.includes(`\`${table}\`.\`id\``)) rows = rows.filter((row) => params.includes(row.id));
    if (sql.includes(`\`${table}\`.\`status\``)) rows = rows.filter((row) => params.includes(row.status));
    return rows;
  };
  return {
    db: {
      select: () => {
        let table = "";
        let condition: any;
        let max: number | undefined;
        let order = "";
        const query: Record<string, any> = {};
        query.from = (value: any) => { table = nameOf(value); return query; };
        query.where = (value: any) => { condition = value; return query; };
        query.limit = (value: number) => { max = value; return query; };
        query.orderBy = (value: any) => {
          order = dialect.sqlToQuery(value).sql;
          state.orders.push({ table, sql: order });
          return query;
        };
        for (const method of ["innerJoin", "leftJoin", "for"]) query[method] = () => query;
        query.then = (resolve: (rows: any[]) => unknown, reject: (reason: unknown) => unknown) => {
          let rows = [...filter(table, state.rows[table] ?? [], condition)];
          const column = order.match(/`[^`]+`\.`([^`]+)` (asc|desc)/);
          if (column) {
            const key = column[1] === "created_at" ? "createdAt" : column[1]!;
            rows.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (column[2] === "desc" ? -1 : 1));
          }
          if (max !== undefined) rows = rows.slice(0, max);
          return Promise.resolve(rows).then(resolve, reject);
        };
        return query;
      },
      update: (table: any) => ({ set: (values: any) => ({ where: async (condition: any) => {
        const name = nameOf(table);
        const rows = filter(name, state.rows[name] ?? [], condition);
        rows.forEach((row) => Object.assign(row, values));
        state.updates.push({ table: name, values });
        return [{ affectedRows: rows.length || (name === "agents" ? 1 : 0) }];
      } }) }),
      insert: (table: any) => ({ values: async (value: any) => {
        const name = nameOf(table);
        const rows = state.rows[name] ??= [];
        rows.push({ ...value, sequence: Math.max(0, ...rows.map((row) => row.sequence ?? 0)) + 1, createdAt: new Date(0) });
      } }),
    },
    withTransaction: async (run: () => Promise<unknown>) => run(),
  };
});
vi.mock("@/lib/access", () => ({ requireCollaborationAccess: vi.fn(async () => ({ collaboration: { id: "collaboration" } })) }));
vi.mock("@/services/projects", () => ({ listProjects: vi.fn(async () => []) }));
vi.mock("@/services/agent-engine", () => ({
  advanceAgentWorkflow: vi.fn(), completeAgentTurn: vi.fn(), refreshAgentJobContext: vi.fn(async (job) => job.payload),
}));
vi.mock("@/services/actor", () => ({ authorizeActor: vi.fn(async () => "participant") }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { getCollaborationDetail } from "../src/services/collaborations";
import { pollConnectorJob } from "../src/services/connectors";
import { listAcceptance, submitAcceptance } from "../src/services/acceptance";

beforeEach(() => {
  const sameTime = new Date("2026-11-11T12:00:00.000Z");
  state.orders = []; state.updates = [];
  state.rows = {
    messages: [
      { id: "a-new", sequence: 2, body: "新的实施授权", authorType: "user", metadata: {}, createdAt: sameTime },
      { id: "z-old", sequence: 1, body: "旧的只读限制", authorType: "user", metadata: {}, createdAt: sameTime },
    ],
    participants: [{ participant: { id: "participant" }, project: { id: "project" }, agent: { id: "agent" } }],
    acceptance_runs: [
      { id: "z-old-pass", sequence: 1, workItemId: "work", participantId: "participant", status: "passed", createdAt: sameTime },
      { id: "a-new-fail", sequence: 2, workItemId: "work", participantId: "participant", status: "failed", createdAt: sameTime },
    ],
    audit_events: [
      { id: "z-old", sequence: 1, actorId: "agent", action: "connector.capabilities", metadata: { executionMode: "read-only" }, createdAt: sameTime },
      { id: "a-new", sequence: 2, actorId: "agent", action: "connector.capabilities", metadata: { executionMode: "workspace-write" }, createdAt: sameTime },
    ],
    connector_jobs: [
      { id: "a-new-job", sequence: 2, agentId: "agent", collaborationId: "collaboration", status: "pending", attempts: 0, payload: {}, createdAt: sameTime },
      { id: "z-old-job", sequence: 1, agentId: "agent", collaborationId: "collaboration", status: "pending", attempts: 0, payload: {}, createdAt: sameTime },
    ],
  };
});

describe("同毫秒事件按数据库序列排序", () => {
  it("最新用户授权由sequence确定，UUID和相同timestamp不会颠倒指令", async () => {
    const detail = await getCollaborationDetail("user", "collaboration");
    expect(detail.messages.map((row) => row.id)).toEqual(["z-old", "a-new"]);
    expect(detail.messages.filter((row) => row.authorType === "user").at(-1)?.body).toBe("新的实施授权");
    expect(state.orders.find((order) => order.table === "messages")?.sql).toContain("`messages`.`sequence` asc");
  });

  it("任务回执、验收、审计及能力展示均以最新插入为准", async () => {
    const detail = await getCollaborationDetail("user", "collaboration");
    expect(detail.jobs.map((row) => row.id)).toEqual(["a-new-job", "z-old-job"]);
    expect(detail.acceptanceRuns[0]?.status).toBe("failed");
    expect(detail.auditEvents[0]?.id).toBe("a-new");
    expect(detail.connectorCapabilities[0]?.executionMode).toBe("workspace-write");
  });

  it("Connector在同毫秒多任务中按先插入先领取", async () => {
    const claimed = await pollConnectorJob("agent", 0);
    expect(claimed?.id).toBe("z-old-job");
    expect(state.orders.find((order) => order.table === "connector_jobs")?.sql).toContain("`connector_jobs`.`sequence` asc");
  });

  it("验收列表将同毫秒较新的失败放在旧通过之前", async () => {
    const runs = await listAcceptance("collaboration");
    expect(runs.map((row) => row.status)).toEqual(["failed", "passed"]);
  });

  it("同毫秒的新失败不能被旧通过覆盖为协作完成", async () => {
    state.rows.work_items = [{ id: "work", status: "completed", assigneeParticipantId: "participant" }];
    await submitAcceptance({ kind: "participant", id: "participant" }, "collaboration", { status: "passed", summary: "一般健康检查" });
    expect(state.updates.some((update) => update.values.status === "completed")).toBe(false);
    expect(state.orders.find((order) => order.table === "acceptance_runs")?.sql).toContain("`acceptance_runs`.`sequence` desc");
  });
});

describe("数据库时间及序列定义", () => {
  it("四张事件表都有独立自增唯一序列，创建时间保留毫秒", () => {
    const dialect = new MySqlDialect();
    for (const table of [schema.messages, schema.connectorJobs, schema.acceptanceRuns, schema.auditEvents]) {
      expect(table.sequence).toMatchObject({ autoIncrement: true });
      expect(table.sequence.isUnique).toBe(true);
      expect(dialect.sqlToQuery(table.createdAt.default as any).sql).toBe("(now(3))");
    }
  });
});
