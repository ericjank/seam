import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, type SharedContract } from "@seam/protocol";
import { createHash } from "node:crypto";

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
  getLifecycleContext, getLifecycleSnapshot, pauseLifecycle, startLifecycle, terminateLifecycle,
} from "../src/services/lifecycle";

const actor = (id: string) => ({ kind: "participant" as const, id });
const plan = (side: string) => `## ${side} 实施方案\n\n${"检查仓库现状，确认接口责任、开发步骤、测试与实际证据；未经管理员确认不得执行修改。".repeat(4)}`;
const submit = (id: string, revision = 1, content = plan(id)) => applyLifecycleAction(actor(id), "collab", { type: "plan.submit", revision, content });
const report = (id: string, revision = 1, status: "passed" | "failed" = "passed") => applyLifecycleAction(actor(id), "collab", { type: "execution.report", revision, status, summary: `${id} 完成代码和测试；${status}`, evidence: { tests: status, commands: ["pnpm test"] } });
async function compose(revision = 1, extra = "", overrides: Partial<SharedContract> = {}) {
  const context = (await getLifecycleContext("collab"))!;
  const ids = context.requiredParticipantIds;
  return applyLifecycleAction(actor(ids[0]!), "collab", { type: "plan.compose", revision, baseDocumentHash: context.documentHash, contract: {
    effectiveRequirements: [{ id: "quote", text: "实现报价接口和真实错误边界" }], retiredRequirements: [],
    serviceExpectations: [],
    scope: "双方实现同一份报价 HTTP 契约并运行真实联合验证，不访问实际业务数据。" + extra,
    interfaces: [{ id: "quote", definition: "POST /quote 接收 sku 和 quantity，返回整数分 subtotal，错误返回 400。" }],
    responsibilities: ids.map((participantId) => ({ participantId, changes: "按共同约定实现本项目报价接口职责，保留已有工作并运行本地测试。" })),
    acceptanceCases: ids.map((runnerParticipantId, index) => ({ id: `joint-${index}`, runnerParticipantId, description: "真实调用双方报价 HTTP 接口并检查正常与异常边界", command: "node --test joint.test.mjs", expectedResult: "全部通过", requiredAssertions: ["real HTTP error"] })),
    risks: "仅合成环境，服务未就绪时如实报告未执行。", changeSummary: "本轮统一明确接口字段、双方实施职责与真实联合验收用例。" + extra,
    impactedParticipantIds: ids, retainedDecisions: revision > 1 ? ["保留已确认的基础报价接口行为"] : [],
    ...overrides,
  } });
}
async function joint(revision = 1, status: "passed" | "failed" | "not_run" = "passed") {
  const context = (await getLifecycleContext("collab"))!;
  for (const id of context.requiredParticipantIds) await applyLifecycleAction(actor(id), "collab", { type: "integration.report", revision, documentHash: context.documentHash!,
    runs: [{ id: `fixture-${id}-${revision}`, command: "node --test joint.test.mjs", exitCode: 0, output: "Synthetic unit fixture, no real execution", assertions: ["real HTTP error"], source: "local-test", capturedAt: new Date().toISOString() }],
    checks: context.contract!.acceptanceCases.filter((item) => item.runnerParticipantId === id).map((item) => ({ caseId: item.id, status, command: item.command, summary: `合成联测回执 ${status}`, evidence: { fixture: true }, assertionNames: ["real HTTP error"], runIds: [`fixture-${id}-${revision}`] })),
  });
}
async function agreed(revision = 1, overrides: Partial<SharedContract> = {}) {
  await submit("00000000-0000-4000-8000-000000000001", revision); await submit("00000000-0000-4000-8000-000000000002", revision); await compose(revision, "", overrides);
  const context = (await getLifecycleContext("collab"))!;
  for (const id of ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]) await applyLifecycleAction(actor(id), "collab", { type: "plan.confirm", revision, documentHash: context.documentHash! });
  return (await getLifecycleContext("collab"))!;
}
async function approved(revision = 1, overrides: Partial<SharedContract> = {}) {
  const context = await agreed(revision, overrides);
  return approveLifecycle("admin", "collab", { revision, documentHash: context.documentHash! });
}

beforeEach(() => {
  state.role = "owner";
  state.rows = {
    collaborations: [{ id: "collab", title: "双端共同开发", objective: "减少表单，让双方 AI 协商并实施接口联调", status: "draft" }],
    participants: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"].map((id) => ({ id, collaborationId: "collab", projectId: `project-${id}`, agentId: `agent-${id}`, role: "participant", status: "active", createdAt: new Date() })),
    projects: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"].map((id) => ({ id: `project-${id}`, name: `项目 ${id}` })),
    agents: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"].map((id) => ({ id: `agent-${id}`, status: "online", lastSeenAt: new Date() })),
    collaboration_lifecycles: [], lifecycle_revisions: [], lifecycle_contributions: [], messages: [], connector_jobs: [],
  };
  vi.clearAllMocks();
});

describe("管理员控制的共同开发生命周期", () => {
  it("旧文档没有有效要求清单时，增量升级仍提供完整上版原文，不能丢掉历史要求来源", async () => {
    await startLifecycle("admin", "collab"); await agreed();
    const legacy=state.rows.lifecycle_revisions![0]!; delete legacy.sharedContract.effectiveRequirements;
    const next=await appendLifecycleRequirements("admin","collab",{requirements:"只追加新错误边界，保留旧约束"});
    expect(next.requirements).toBe("只追加新错误边界，保留旧约束");
    expect(next.baseline!.document).toBe(legacy.document);
    expect(next.baseline!.document).toContain("实施范围");
  });
  it("新文档服务必须关联本版语义探测，验收不能只通过健康检查而遗漏业务断言", async () => {
    await startLifecycle("admin", "collab");
    const [a,b] = (await getLifecycleContext("collab"))!.requiredParticipantIds as [string,string];
    await submit(a); await submit(b);
    const serviceExpectation = { name: "quote", publisherParticipantId: a, healthPath: "/health", status: 200, bodyChecks: [{ path: "ready", equals: true }, { path: "revision", equals: 1 }] };
    await compose(1, "严格语义验证", { serviceExpectations: [serviceExpectation], acceptanceCases: [a,b].map((runnerParticipantId,index) => ({ id: `strict-${index}`, runnerParticipantId, command: "node --test joint.test.mjs", description: "健康及业务金额断言都必须真实通过", expectedResult: "全部通过", requiredAssertions: ["health", "business amount"] })) });
    const documentHash=(await getLifecycleContext("collab"))!.documentHash!;
    for(const id of [a,b])await applyLifecycleAction(actor(id),"collab",{type:"plan.confirm",revision:1,documentHash});
    await approveLifecycle("admin","collab",{revision:1,documentHash});
    const service = { type:"service.publish" as const,revision:1,name:"quote",baseUrl:"http://127.0.0.1:12345",healthPath:"/health",ttlSeconds:300,
      probe:{ok:true,status:200,checkedAt:new Date().toISOString(),revision:1,documentHash,expectationHash:createHash("sha256").update(canonicalJson(serviceExpectation)).digest("hex")} };
    await expect(applyLifecycleAction(actor(a),"collab",{...service,probe:{...service.probe,revision:2}})).rejects.toMatchObject({status:422});
    await expect(applyLifecycleAction(actor(a),"collab",{...service,probe:{...service.probe,expectationHash:"0".repeat(64)}})).rejects.toMatchObject({status:422});
    await applyLifecycleAction(actor(a),"collab",service);
    await report(a);await report(b);
    const action={type:"integration.report" as const,revision:1,documentHash,runs:[{id:"strict-run",command:"node --test joint.test.mjs",exitCode:0,output:"synthetic state-machine fixture",assertions:["health"],source:"local-test" as const,capturedAt:new Date().toISOString()}],checks:[{caseId:"strict-0",status:"passed" as const,command:"node --test joint.test.mjs",summary:"仅健康",evidence:{fixture:true},assertionNames:["health"],runIds:["strict-run"]}]};
    await expect(applyLifecycleAction(actor(a),"collab",action)).rejects.toMatchObject({status:422});
    action.checks[0]!.assertionNames.push("business amount");
    await expect(applyLifecycleAction(actor(a),"collab",action)).rejects.toMatchObject({status:422});
    action.runs[0]!.assertions.push("business amount");await applyLifecycleAction(actor(a),"collab",action);
    expect((await getLifecycleContext("collab"))!.phase).toBe("joint_verifying");
  });
  it("完整闭环：同版双确认、人工批准、双端报告、追加新版本、人工终止", async () => {
    expect((await startLifecycle("admin", "collab")).phase).toBe("planning");
    const approval = await approved();
    expect(approval.phase).toBe("executing");
    expect(approval.approvedHash).toBe(approval.documentHash);
    await report("00000000-0000-4000-8000-000000000001");
    expect((await getLifecycleContext("collab"))!.phase).toBe("executing");
    await report("00000000-0000-4000-8000-000000000002");
    expect((await getLifecycleContext("collab"))!.phase).toBe("joint_verifying");
    await joint();
    const reviewed = (await getLifecycleContext("collab"))!;
    expect(reviewed.phase).toBe("awaiting_review");
    expect(reviewed.report).toContain("项目 00000000-0000-4000-8000-000000000001");
    expect(reviewed.report).toContain("项目 00000000-0000-4000-8000-000000000002");
    expect(state.rows.collaborations![0]!.status).toBe("validating");
    const next = await appendLifecycleRequirements("admin", "collab", { requirements: "增加幂等重试与回归验证" });
    expect(next).toMatchObject({ revision: 2, phase: "planning", document: null, approvedHash: null, confirmations: [], reports: [] });
    expect(next.requirements).toContain("增加幂等重试与回归验证");
    expect(state.rows.lifecycle_revisions![0]!.report).toBe(reviewed.report);
    await approved(2); await report("00000000-0000-4000-8000-000000000001", 2); await report("00000000-0000-4000-8000-000000000002", 2); await joint(2);
    expect((await terminateLifecycle("admin", "collab", { revision: 2 })).phase).toBe("terminated");
    expect(state.rows.collaborations![0]!.status).toBe("completed");
  });

  it("不能绕过管理员、同版确认或内容哈希", async () => {
    await startLifecycle("admin", "collab");
    await expect(report("00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({ status: 409 });
    await expect(applyLifecycleAction({ kind: "user", id: "admin" }, "collab", { type: "plan.submit", revision: 1, content: plan("user") })).rejects.toMatchObject({ status: 403 });
    await submit("00000000-0000-4000-8000-000000000001"); await submit("00000000-0000-4000-8000-000000000002"); await compose();
    const current = (await getLifecycleContext("collab"))!;
    await expect(approveLifecycle("admin", "collab", { revision: 1, documentHash: current.documentHash! })).rejects.toMatchObject({ status: 409 });
    await applyLifecycleAction(actor("00000000-0000-4000-8000-000000000001"), "collab", { type: "plan.confirm", revision: 1, documentHash: current.documentHash! });
    await expect(applyLifecycleAction(actor("00000000-0000-4000-8000-000000000002"), "collab", { type: "plan.confirm", revision: 1, documentHash: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    await applyLifecycleAction(actor("00000000-0000-4000-8000-000000000002"), "collab", { type: "plan.confirm", revision: 1, documentHash: current.documentHash! });
    state.role = "member";
    await expect(approveLifecycle("member", "collab", { revision: 1, documentHash: current.documentHash! })).rejects.toMatchObject({ status: 403 });
    state.role = "owner";
    await expect(approveLifecycle("admin", "collab", { revision: 1, documentHash: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect((await getLifecycleContext("collab"))!.phase).toBe("awaiting_approval");
  });

  it("协商中修改方案会作废旧内容确认，旧任务及旧 hash 被拒绝", async () => {
    await startLifecycle("admin", "collab");
    await submit("00000000-0000-4000-8000-000000000001"); await submit("00000000-0000-4000-8000-000000000002"); await compose();
    const before = (await getLifecycleContext("collab"))!;
    const snapshot = await getLifecycleSnapshot("collab");
    await applyLifecycleAction(actor("00000000-0000-4000-8000-000000000001"), "collab", { type: "plan.confirm", revision: 1, documentHash: before.documentHash! });
    await submit("00000000-0000-4000-8000-000000000002", 1, `${plan("00000000-0000-4000-8000-000000000002")}\n\n解决另一方提出的接口冲突`);
    expect((await getLifecycleContext("collab"))!.phase).toBe("plan_synthesis");
    await compose(1, "解决另一方提出的接口冲突");
    const after = (await getLifecycleContext("collab"))!;
    expect(after.documentHash).not.toBe(before.documentHash);
    expect(after.confirmations).toEqual([]);
    await expect(assertLifecycleJobCurrent("collab", snapshot)).rejects.toMatchObject({ status: 409 });
    await expect(applyLifecycleAction(actor("00000000-0000-4000-8000-000000000002"), "collab", { type: "plan.confirm", revision: 1, documentHash: before.documentHash! })).rejects.toMatchObject({ status: 409 });
  });

  it("同批最后确认的快照可回执；旧修订及执行中的追加/终止被拒绝", async () => {
    await startLifecycle("admin", "collab");
    await submit("00000000-0000-4000-8000-000000000001"); await submit("00000000-0000-4000-8000-000000000002"); await compose();
    const snapshot = await getLifecycleSnapshot("collab");
    const context = (await getLifecycleContext("collab"))!;
    for (const id of ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]) await applyLifecycleAction(actor(id), "collab", { type: "plan.confirm", revision: 1, documentHash: context.documentHash! });
    await expect(assertLifecycleJobCurrent("collab", snapshot)).resolves.toMatchObject({ phase: "awaiting_approval" });
    await approveLifecycle("admin", "collab", { revision: 1, documentHash: context.documentHash! });
    await expect(appendLifecycleRequirements("admin", "collab", { requirements: "打断开发" })).rejects.toMatchObject({ status: 409 });
    await expect(terminateLifecycle("admin", "collab")).rejects.toMatchObject({ status: 409 });
    await report("00000000-0000-4000-8000-000000000001"); await report("00000000-0000-4000-8000-000000000002"); await joint();
    await appendLifecycleRequirements("admin", "collab", { requirements: "新的要求" });
    await expect(report("00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({ status: 409 });
    await expect(assertLifecycleJobCurrent("collab", snapshot)).rejects.toMatchObject({ status: 409 });
  });

  it("失败报告保留真实状态，收齐后仍待管理员审阅且不会自动终止", async () => {
    await startLifecycle("admin", "collab"); await approved();
    await report("00000000-0000-4000-8000-000000000001", 1, "failed"); await report("00000000-0000-4000-8000-000000000002");
    const context = (await getLifecycleContext("collab"))!;
    expect(context.phase).toBe("awaiting_review");
    expect(context.reports.find((item) => item.participantId === "00000000-0000-4000-8000-000000000001")?.status).toBe("failed");
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
  it("统一契约由协调方汇总，异议使所有确认失效，不能重交被拒绝的相同契约", async () => {
    await startLifecycle("admin", "collab"); await submit("00000000-0000-4000-8000-000000000001"); await submit("00000000-0000-4000-8000-000000000002");
    expect((await getLifecycleContext("collab"))!.phase).toBe("plan_synthesis");
    await compose();
    const before = (await getLifecycleContext("collab"))!;
    state.rows.connector_jobs!.push(...before.requiredParticipantIds.map((id, index) => ({ id: `review-${index}`, collaborationId: "collab", kind: "collaboration.turn", agentId: `agent-${id}`, status: "running", payload: { lifecycleSnapshot: { revision: 1, phase: "plan_confirmation", documentHash: before.documentHash } } })));
    await applyLifecycleAction(actor("00000000-0000-4000-8000-000000000001"), "collab", { type: "plan.confirm", revision: 1, documentHash: before.documentHash! });
    await applyLifecycleAction(actor("00000000-0000-4000-8000-000000000002"), "collab", { type: "plan.reject", revision: 1, documentHash: before.documentHash!, reason: "缺少无效数量返回 400 的明确边界约定，请补充" });
    expect((await getLifecycleContext("collab"))!.confirmations).toEqual([]);
    expect(state.rows.connector_jobs!.find((job) => job.id === "review-0")!.status).toBe("cancelled");
    expect(state.rows.connector_jobs!.find((job) => job.id === "review-1")!.status).toBe("running"); // The rejecting receipt must still commit normally.
    await expect(compose()).rejects.toMatchObject({ status: 422 });
    await compose(1, "明确无效数量返回400");
    expect((await getLifecycleContext("collab"))!.documentHash).not.toBe(before.documentHash);
    expect((await getLifecycleContext("collab"))!.objections).toHaveLength(1);
  });

  it("联测不能提前、跨方或遗漏，未执行结果不能显示通过", async () => {
    await startLifecycle("admin", "collab"); await approved();
    await expect(joint()).rejects.toMatchObject({ status: 409 });
    await report("00000000-0000-4000-8000-000000000001"); await report("00000000-0000-4000-8000-000000000002");
    await expect(terminateLifecycle("admin", "collab")).rejects.toMatchObject({ status: 409 });
    const c = (await getLifecycleContext("collab"))!;
    await expect(applyLifecycleAction(actor("00000000-0000-4000-8000-000000000001"), "collab", { type: "integration.report", revision: 1, documentHash: c.documentHash!, checks: [{ caseId: "joint-1", status: "passed", command: "node test", summary: "跨方伪造", evidence: { fixture: true } }] })).rejects.toMatchObject({ status: 422 });
    await joint(1, "not_run");
    expect((await getLifecycleContext("collab"))!.report).toContain("未执行用例");
  });

  it("暂停取消在途工作，恢复保留批准但旧任务不能回传", async () => {
    await startLifecycle("admin", "collab"); await approved();
    state.rows.connector_jobs!.push({ id: "running-job", collaborationId: "collab", kind: "collaboration.turn", status: "running" });
    const snapshot = await getLifecycleSnapshot("collab");
    expect((await pauseLifecycle("admin", "collab", true)).paused).toBe(true);
    expect(state.rows.connector_jobs![0]!.status).toBe("cancelled");
    await expect(assertLifecycleJobCurrent("collab", snapshot)).rejects.toMatchObject({ status: 409 });
    await expect(report("00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({ status: 409 });
    expect((await pauseLifecycle("admin", "collab", false)).approvedHash).toBe(snapshot!.approvedHash);
  });

  it("临时故障有界退避，第三次转需管理员事实，补充后清除阻塞并保留原批准", async () => {
    await startLifecycle("admin", "collab"); const approval = await approved();
    const id = approval.requiredParticipantIds[0]!;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await applyLifecycleAction(actor(id), "collab", { type: "workflow.blocked", revision: 1, kind: "retryable", reason: "本地测试服务暂时不可达，等待真实就绪。", retryAfterSeconds: 5 });
      const context = (await getLifecycleContext("collab"))!;
      expect(context.blocks[0]!.attempts).toBe(attempt);
      expect(context.blocks[0]!.kind).toBe(attempt < 3 ? "retryable" : "needs_admin");
    }
    await expect(pauseLifecycle("admin", "collab", false)).rejects.toMatchObject({ status: 422 });
    const resumed = await pauseLifecycle("admin", "collab", false, "本地服务已恢复，继续原批准版本。");
    expect(resumed.blocks).toEqual([]); expect(resumed.approvedHash).toBe(approval.approvedHash);
    expect(state.rows.messages!.some((row) => row.metadata?.blockResolution && row.body.includes("本地服务已恢复"))).toBe(true);
  });

  it("双方循环等待检测为明确阻塞，拒绝等待自己或无关参与方", async () => {
    await startLifecycle("admin", "collab"); const approval = await approved(); const [a, b] = approval.requiredParticipantIds as [string, string];
    await expect(applyLifecycleAction(actor(a), "collab", { type: "workflow.blocked", revision: 1, kind: "waiting_peer", reason: "等待自己不应进入无穷循环。", dependencyParticipantIds: [a] })).rejects.toMatchObject({ status: 422 });
    await applyLifecycleAction(actor(a), "collab", { type: "workflow.blocked", revision: 1, kind: "waiting_peer", reason: "等待乙方服务就绪后继续本方调用。", dependencyParticipantIds: [b] });
    await applyLifecycleAction(actor(b), "collab", { type: "workflow.blocked", revision: 1, kind: "waiting_peer", reason: "等待甲方服务就绪后继续本方调用。", dependencyParticipantIds: [a] });
    const blocks = (await getLifecycleContext("collab"))!.blocks;
    expect(blocks).toHaveLength(2); expect(blocks.every((block) => block.kind === "needs_admin" && block.reason.includes("循环等待"))).toBe(true);
  });

  it("服务只能获批后发布且必须有健康探测，过期端点从交接上下文移除", async () => {
    await startLifecycle("admin", "collab"); const id = "00000000-0000-4000-8000-000000000001";
    const service = { type: "service.publish" as const, revision: 1, name: "quote", baseUrl: "http://127.0.0.1:19001", healthPath: "/health", ttlSeconds: 30 };
    await expect(applyLifecycleAction(actor(id), "collab", service)).rejects.toMatchObject({ status: 409 });
    const expectation = {name:"quote",publisherParticipantId:id,healthPath:"/health",status:200,bodyChecks:[{path:"ready",equals:true}]};
    const ready = await approved(1,{serviceExpectations:[expectation]});
    await expect(applyLifecycleAction(actor(id), "collab", service)).rejects.toMatchObject({ status: 422 });
    await applyLifecycleAction(actor(id), "collab", { ...service, probe: { ok: true, status: 200, checkedAt: new Date().toISOString(), revision:1, documentHash:ready.documentHash!, expectationHash:createHash("sha256").update(canonicalJson(expectation)).digest("hex") } });
    expect((await getLifecycleContext("collab"))!.services).toHaveLength(1);
    state.rows.lifecycle_contributions!.find((row) => row.participantId === id)!.services[0].expiresAt = new Date(0).toISOString();
    expect((await getLifecycleContext("collab"))!.services).toEqual([]);
  });

  it("联合验收必须关联批准命令、实际断言及成功退出码，日志只按运行ID保存一次", async () => {
    await startLifecycle("admin", "collab"); await approved();
    const [a,b] = (await getLifecycleContext("collab"))!.requiredParticipantIds as [string,string]; await report(a); await report(b);
    const context = (await getLifecycleContext("collab"))!, testCase = context.contract!.acceptanceCases[0]!;
    const run = { id: "observed-command", command: testCase.command, exitCode: 0, output: "ok 1 - real HTTP error", assertions: ["real HTTP error"], source: "local-test" as const, capturedAt: new Date().toISOString() };
    const action = { type: "integration.report" as const, revision: 1, documentHash: context.documentHash!, runs: [run], checks: [{ caseId: testCase.id, status: "passed" as const, command: testCase.command, summary: "实际HTTP错误测试", assertionNames: ["real HTTP error"], runIds: [run.id], evidence: { details: "关联原始记录" } }] };
    await expect(applyLifecycleAction(actor(a), "collab", { ...action, runs: [{ ...run, command: "node --test wrong.test.mjs" }] })).rejects.toMatchObject({ status: 422 });
    await expect(applyLifecycleAction(actor(a), "collab", { ...action, runs: [{ ...run, exitCode: 1 }] })).rejects.toMatchObject({ status: 422 });
    await expect(applyLifecycleAction(actor(a), "collab", { ...action, runs: [{ ...run, assertions: ["unrelated"] }] })).rejects.toMatchObject({ status: 422 });
    await applyLifecycleAction(actor(a), "collab", action); await applyLifecycleAction(actor(a), "collab", action);
    expect((await getLifecycleContext("collab"))!.evidenceRuns.filter((record) => record.id === run.id)).toHaveLength(1);
  });

  it("历史联合回执缺少新增引用字段时正常读取，并保持未关联证据状态", async () => {
    await startLifecycle("admin", "collab"); await approved();
    const [a,b] = (await getLifecycleContext("collab"))!.requiredParticipantIds as [string,string]; await report(a); await report(b); await joint();
    for (const row of state.rows.lifecycle_contributions!) for (const check of row.integrationChecks ?? []) { delete check.assertionNames; delete check.runIds; }
    for (const row of state.rows.lifecycle_contributions!) row.evidenceRuns = []; // Import an explicitly legacy fixture.
    const context = (await getLifecycleContext("collab"))!;
    expect(context.integrationReports.every((entry) => entry.checks.every((check) => check.runIds.length === 0 && check.assertionNames.length === 0))).toBe(true);
    expect(context.evidenceRuns).toEqual([]); expect(context.phase).toBe("awaiting_review");
  });

});
