import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  job: {} as Record<string, any>, jobs: [] as Record<string, any>[], detail: {} as Record<string, any>,
  inserted: [] as { table: string; values: Record<string, any> }[],
}));
vi.mock("@/db", () => ({
  db: {
    select: () => {
      let table = "", limited = false;
      const query: Record<string, any> = {};
      query.from = (value: any) => { table = value[Symbol.for("drizzle:Name")]; return query; };
      for (const method of ["where", "for", "orderBy"]) query[method] = () => query;
      query.limit = () => { limited = true; return query; };
      query.then = (resolve: any, reject: any) => Promise.resolve(table === "collaborations"
        ? [state.detail.collaboration] : limited ? [state.job] : state.jobs).then(resolve, reject);
      return query;
    },
    insert: (table: any) => ({ values: async (values: Record<string, any>) => { state.inserted.push({ table: table[Symbol.for("drizzle:Name")], values }); } }),
    update: () => ({ set: () => ({ where: async () => [{ affectedRows: 1 }] }) }),
  },
  withTransaction: async (run: () => Promise<unknown>) => run(),
}));
vi.mock("@/services/collaborations", () => ({ getCollaborationDetail: vi.fn(async () => state.detail) }));
vi.mock("@/services/artifacts", () => ({ upsertArtifact: vi.fn() }));
vi.mock("@/services/proposals", () => ({ createProposal: vi.fn(), decideProposal: vi.fn() }));
vi.mock("@/services/work-items", () => ({ createWorkItem: vi.fn(), updateWorkItem: vi.fn() }));
vi.mock("@/services/credentials", () => ({ requestCredential: vi.fn() }));
vi.mock("@/services/acceptance", () => ({ submitAcceptance: vi.fn() }));
vi.mock("@/services/lifecycle", () => ({ applyLifecycleAction: vi.fn(), assertLifecycleJobCurrent: vi.fn(), getLifecycleContext: vi.fn() }));

import { advanceAgentWorkflow, buildContext } from "../src/services/agent-engine";

const workflow = { id: "workflow-1", round: 2, maxRounds: 12, autoAdvance: true };
const newJobs = () => state.inserted.filter((entry) => entry.table === "connector_jobs");

beforeEach(() => {
  state.inserted = [];
  state.job = { id: "job", sequence: 10, collaborationId: "collaboration", status: "completed", payload: {
    workflow: { ...workflow }, lifecycleSnapshot: { revision: 1, phase: "planning", documentHash: null, approvedHash: null },
  } };
  state.jobs = [state.job];
  state.detail = {
    collaboration: { id: "collaboration", createdById: "admin", title: "双端协作", type: "custom", objective: "协商后实施", status: "negotiating", negotiationRound: 2 },
    lifecycle: { revision: 1, phase: "plan_synthesis", requirements: "目标", document: "完整文档", documentHash: "a".repeat(64), approvedHash: null,
      requiredParticipantIds: ["a", "b"], contributions: [{ participantId: "a", content: "甲计划" }, { participantId: "b", content: "乙计划" }], confirmations: [], reports: [], report: null },
    participants: ["a", "b"].map((id) => ({ participant: { id, projectId: `project-${id}`, agentId: `agent-${id}`, status: "active", role: "participant", approvalRequired: true }, project: { name: id }, agent: { name: id } })),
    messages: [], artifacts: [], workItems: [], proposals: [], credentials: [], acceptanceRuns: [],
  };
});

describe("生命周期自动推进的迟到回调隔离", () => {
  it("把本方最新动作拒绝原因交给下一轮，成功后不重复旧错误", () => {
    state.detail.jobs = [{ id: "rejected-job", agentId: "agent-a", status: "failed", error: "HTTP要求遗漏独立检查", updatedAt: new Date() }];
    expect(buildContext(state.detail as any, "a").messages.at(-1)?.body).toContain("HTTP要求遗漏独立检查");
    state.detail.jobs.unshift({ id: "success", agentId: "agent-a", status: "completed", updatedAt: new Date() });
    expect(buildContext(state.detail as any, "a").messages).toHaveLength(0);
  });
  it("其他端仍运行时，过期的本方重试按参与方独立补派发",async()=>{
    state.detail.lifecycle.phase="executing";state.job.payload.lifecycleSnapshot.phase="executing";
    state.detail.lifecycle.blocks=[{participantId:"a",kind:"retryable",retryAt:new Date(0).toISOString()}];
    state.jobs.push({id:"peer-running",agentId:"agent-b",status:"running",payload:{lifecycleSnapshot:{revision:1,phase:"executing"}}});
    await advanceAgentWorkflow("job");expect(newJobs()).toHaveLength(1);expect(newJobs()[0]!.values.agentId).toBe("agent-a");
  });
  it("本方主任务已完成的对端仍被调度为只读事实答复；信息进展不耗尽旧推进预算", async () => {
    const now=new Date().toISOString(),requestId=crypto.randomUUID();
    const l=state.detail.lifecycle;l.phase="executing";l.blocks=[{participantId:"a",kind:"gathering_info"}];l.reports=[{participantId:"b",status:"passed"}];
    l.informationRequests=[{id:requestId,revision:1,phase:"executing",requestedByParticipantId:"a",targetParticipantIds:["b"],stage:"peer",status:"pending",question:"对端接口金额规则是什么？",answer:null,createdAt:now,responses:[]}];
    state.job.payload.lifecycleSnapshot.phase="executing";
    await advanceAgentWorkflow("job");expect(newJobs()).toHaveLength(1);
    expect(newJobs()[0]!.values).toMatchObject({agentId:"agent-b",payload:{context:{informationTask:{requestId,mode:"peer"}}}});
    state.inserted=[];l.informationRequests[0].status="answered";l.blocks=[];
    state.job.payload.workflow.round=12;state.job.result={agentTurn:{actions:[{type:"information.respond"}]}};
    await advanceAgentWorkflow("job");expect(newJobs()).toHaveLength(1);expect(newJobs()[0]!.values.agentId).toBe("agent-a");
    expect(newJobs()[0]!.values.payload.workflow).toMatchObject({round:1,maxRounds:12});
  });
  it("需要管理员事实时停止派发，等待对端服务时不按轮询反复唤起模型", async () => {
    state.detail.lifecycle.phase = "executing"; state.job.payload.lifecycleSnapshot.phase = "executing";
    state.detail.lifecycle.blocks = [{ participantId: "a", kind: "needs_admin" }];
    await advanceAgentWorkflow("job"); expect(newJobs()).toHaveLength(0);
    state.detail.lifecycle.blocks = [{ participantId: "a", kind: "waiting_peer", dependencyParticipantIds: ["b"], retryAt: new Date(0).toISOString() }];
    state.detail.lifecycle.reports = [{ participantId: "b", status: "passed" }]; state.detail.lifecycle.services = [];
    await advanceAgentWorkflow("job"); expect(newJobs()).toHaveLength(0);
    state.detail.lifecycle.services.push({ participantId: "b", expiresAt: new Date(Date.now() + 60000).toISOString() });
    await advanceAgentWorkflow("job"); expect(newJobs()).toHaveLength(1);
    expect(newJobs()[0]!.values.agentId).toBe("agent-a");
  });

  it("临时错误退避时间到达前不派发，过期后只派发未完成方", async () => {
    state.detail.lifecycle.phase = "executing"; state.job.payload.lifecycleSnapshot.phase = "executing";
    state.detail.lifecycle.reports = [{ participantId: "b", status: "passed" }];
    state.detail.lifecycle.blocks = [{ participantId: "a", kind: "retryable", retryAt: new Date(Date.now() + 60000).toISOString() }];
    await advanceAgentWorkflow("job"); expect(newJobs()).toHaveLength(0);
    state.detail.lifecycle.blocks[0].retryAt = new Date(0).toISOString();
    await advanceAgentWorkflow("job"); expect(newJobs()).toHaveLength(1);
  });
  it("计划收齐后仅派发协调方汇总统一契约", async () => {
    await advanceAgentWorkflow("job");
    expect(newJobs()).toHaveLength(1);
    for (const job of newJobs()) expect(job.values.payload.lifecycleSnapshot).toMatchObject({ revision: 1, phase: "plan_synthesis", documentHash: "a".repeat(64) });
    const dispatch = state.inserted.find(entry => entry.table === "messages")!.values;
    expect(dispatch.metadata.dispatch.targets).toEqual([{ jobId: newJobs()[0]!.values.id, participantId: "a", projectId: "project-a", projectName: "a", agentId: "agent-a", agentName: "a" }]);
    expect(dispatch.body).toContain("项目「a」 · Agent「a」");
    expect(dispatch.body).not.toContain("Agent「b」");
  });

  it("管理员追加新版本后，旧版本回调不能抢占新流程预算", async () => {
    state.detail.lifecycle.revision = 2;
    state.detail.lifecycle.phase = "planning";
    state.detail.lifecycle.contributions = [];
    await advanceAgentWorkflow("job");
    expect(state.inserted).toEqual([]);
  });

  it("管理员已批准执行后，旧确认回调不能创建实施批次", async () => {
    state.job.payload.lifecycleSnapshot.phase = "plan_confirmation";
    state.detail.lifecycle.phase = "executing";
    state.detail.lifecycle.approvedHash = state.detail.lifecycle.documentHash;
    await advanceAgentWorkflow("job");
    expect(state.inserted).toEqual([]);
  });

  it("同修订旧批次回调只补当前参与方缺口，不继承旧批次预算", async () => {
    state.jobs.push({ ...state.job, id: "new-job", sequence: 11, status: "failed", payload: { ...state.job.payload, workflow: { ...workflow, id: "workflow-new" } } });
    await advanceAgentWorkflow("job");
    expect(newJobs()).toHaveLength(1);
    expect(newJobs()[0]!.values.agentId).toBe("agent-a");
  });

  it("确认期重写文档后，旧hash批次结束仍会派发最新hash重新确认", async () => {
    state.detail.lifecycle.phase = "plan_confirmation";
    state.job.payload.lifecycleSnapshot.phase = "plan_confirmation";
    state.job.payload.lifecycleSnapshot.documentHash = "0".repeat(64);
    await advanceAgentWorkflow("job");
    expect(newJobs()).toHaveLength(2);
    expect(newJobs()[0]!.values.payload.lifecycleSnapshot.documentHash).toBe("a".repeat(64));
  });

  it("耗尽当前参与方预算只写一次停止消息，后续迟到回调保持停止", async () => {
    state.detail.collaboration.maxNegotiationRounds=12;
    state.jobs=Array.from({length:12},(_,index)=>({...state.job,id:`prior-${index}`,agentId:"agent-a",payload:{...state.job.payload,context:{participant:{id:"a"},lifecycle:{revision:1,phase:"plan_synthesis"}}}}));
    await advanceAgentWorkflow("job");
    expect(newJobs()).toHaveLength(0);
    expect(state.inserted).toHaveLength(1);
    const receipt = state.inserted[0]!.values;
    state.detail.messages.push(receipt);
    state.inserted = [];
    await advanceAgentWorkflow("job");
    expect(state.inserted).toEqual([]);
  });
});
