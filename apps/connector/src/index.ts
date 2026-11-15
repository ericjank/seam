import { verifyExecutionReuse } from "./execution-reuse.js";
import { createAgentAdapter, describeExecutionPolicy } from "@seam/agent-adapters";
import { createHash, randomUUID } from "node:crypto";
import { CONNECTOR_PROTOCOL_VERSION, collaborationContextSchema } from "@seam/protocol";
import type { ConnectorConfig } from "./config.js";
import { ExecutionJournal, type JournalEntry, type ExecutionCheckpoint, type ControlReceipt } from "./journal.js";
import { withWorkspaceLock, workspaceBaseline } from "./workspace.js";
import { PlatformError, PlatformClient } from "./client.js";
import { createA2AHandler } from "./a2a.js";
import { CredentialStore } from "./credential-store.js";
import { assertOutboundPolicy } from "./outbound-policy.js";
import { runLocalTest } from "./local-test.js";
import { attachCommandEvidence, captureCommand, probeServices, ServiceReadinessError } from "./evidence.js";
import { discoverProject } from "./discovery.js";
import { collectTestFiles, checkPinnedTests, fingerprintInformation, verifyCachedFact } from "./integrity.js";
import { connectorBuildInfo } from "./build-info.js";
import { runIndependentChecks, buildConfiguredIntegrationReport } from "./independent-checks.js";

export async function runConnector(config: ConnectorConfig) {
  const adapter = createAgentAdapter(config.adapter, { codexSandbox: config.codexSandbox, appServerStateDir: config.appServerStateDir, codexNetworkAccess: config.codexNetworkAccess });
  const health = await adapter.healthCheck(config.projectRoot);
  if (!health.ok) throw new Error(`Agent 不可用：${health.detail}`);
  const client = new PlatformClient(config);
  const journal = new ExecutionJournal(config);
  let active: { id: string; attempts: number; controller: AbortController; recoveryKey: string; leaseTimer: ReturnType<typeof setTimeout> } | undefined;
  const renewLocalLease = (expiresAt: string) => {
    if (!active) return;
    clearTimeout(active.leaseTimer);
    const controller = active.controller;
    active.leaseTimer = setTimeout(() => controller.abort(new Error("任务租约已过期，停止本地执行")), Math.max(0, Date.parse(expiresAt) - Date.now()));
    active.leaseTimer.unref();
  };
  const deliver = async (entry: JournalEntry) => {
    try {
      await client.complete(entry.jobId, entry.result, entry.error, entry.attempts);
      await journal.save({ ...entry, state: "acknowledged" });
    } catch (error) {
      if (error instanceof PlatformError && !error.retryable) await journal.save({ ...entry, state: "rejected", rejection: error.message });
      throw error;
    }
  };
  const credentialStore = new CredentialStore(config.agentId);
  const a2a = createA2AHandler(adapter, config.projectRoot, config.agentId, `${config.platformUrl}/api/a2a/${config.agentId}`);
  const build = connectorBuildInfo();
  const capabilities = {
    adapter: config.adapter,
    executionMode: config.adapter === "codex" || config.adapter === "codex-app-server" ? config.codexSandbox ?? "read-only" : "external" as const,
    testConfigured: Boolean(process.env.SEAM_TEST_COMMAND),
    supportsInformationLookup: true,
    protocolVersion: CONNECTOR_PROTOCOL_VERSION, build,
  };
  const deliverControl = async (entry: ControlReceipt) => {
    const response = await client.heartbeat(capabilities, AbortSignal.timeout(15_000), { id: entry.jobId, attempts: entry.attempts, cancelled: true });
    if (response.jobState?.cancellationAcknowledged) await journal.saveControl({ ...entry, state: "acknowledged" });
    else if (response.jobState?.receiptRejected) await journal.saveControl({ ...entry, state: "rejected", reason: "停止确认对应任务或领取轮次已失效" });
  };
  await client.heartbeat(capabilities);
  let heartbeatPending = false;
  let heartbeatStopped = false;
  let heartbeatController: AbortController | undefined;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    heartbeatController = new AbortController();
    const observed = active;
    void client.heartbeat(capabilities, AbortSignal.any([heartbeatController.signal, AbortSignal.timeout(15_000)]), observed ? { id: observed.id, attempts: observed.attempts, recoveryKey:observed.recoveryKey } : undefined).then((response) => {
      if (active !== observed || !observed) return;
      if (response.jobState?.cancelRequested) observed.controller.abort(new Error("平台已取消或暂停当前任务"));
      else if (response.jobState?.leaseUntil) renewLocalLease(response.jobState.leaseUntil);
    }).catch((error: unknown) => {
      if (!heartbeatStopped) console.error("Connector 心跳失败", error instanceof Error ? error.message : "中心暂不可达");
    }).finally(() => { heartbeatPending = false; });
  }, 20_000);
  heartbeatTimer.unref();
  console.log(`Seam Connector 已连接：${config.adapter}，项目目录 ${config.projectRoot}`);
  console.log(`本地执行策略：${describeExecutionPolicy(config.adapter, { codexSandbox: config.codexSandbox, codexNetworkAccess: config.codexNetworkAccess })}`);

  try {
  do {
    let phase = "领取任务";
    try {
      for (const entry of await journal.pendingControls()) {
        try { await deliverControl(entry); } catch (error) { console.error("停止确认待重发", error instanceof Error ? error.message : "中心暂不可达"); }
      }
      // Drain durable receipts before claiming any new local work.
      for (const entry of await journal.pending()) {
        try { await deliver(entry); } catch (error) {
          if (!(error instanceof PlatformError) || error.retryable) throw error;
          console.error(`Connector 提交任务 ${entry.jobId} 回执失败`, error.message);
        }
      }
      let recovering = false;
      let recoveredJob: import("@seam/protocol").ConnectorJob | null = null;
      if (adapter.recover) for (const entry of await journal.running()) {
        try {
          await withWorkspaceLock(config.projectRoot, new AbortController().signal, async()=>{
            const current = await journal.read(entry.jobId);
            if(current?.state!=="running"||current.attempts!==entry.attempts)return;
            recoveredJob=await client.recover(entry.jobId,entry.attempts,entry.recoveryKey);
            await journal.save({...current,attempts:recoveredJob.attempts});
          },config.workspaceLockDir);
        }catch(error){
          if(error instanceof PlatformError&&!error.retryable)await journal.save({...entry,state:"rejected",rejection:error.message});else throw error;
        }
        if(recoveredJob){recovering=true;break;}
      }
      const job = recoveredJob ?? await client.poll();
      if (!job) { if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs)); continue; }
      const controller = new AbortController();
      const recoveryKey=(await journal.read(job.id))?.recoveryKey??randomUUID();
      active = { id: job.id, attempts: job.attempts, controller, recoveryKey, leaseTimer: setTimeout(() => controller.abort(), 60_000) };
      renewLocalLease(job.leaseUntil ?? new Date(Date.now() + 60_000).toISOString());
      let result: Record<string, unknown> | undefined;
      let executionError: string | undefined;
      try {
        const receipt = await client.heartbeat(capabilities, AbortSignal.timeout(15_000), { id: job.id, attempts: job.attempts, recoveryKey });
        if (receipt.jobState?.cancelRequested) controller.abort(new Error("领取轮次已失效或任务已取消"));
        const expiresAt = Date.parse(receipt.jobState?.leaseUntil ?? "");
        if (controller.signal.aborted || receipt.jobState?.cancelRequested || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("任务领取未获当前轮次执行确认，未运行本机Agent");
        renewLocalLease(receipt.jobState.leaseUntil);
        const cached = recovering ? null : await journal.begin(job,recoveryKey);
        if (cached) { result = cached.result; executionError = cached.error; }
        else await withWorkspaceLock(config.projectRoot, controller.signal, async () => {
          const before = await workspaceBaseline(config.projectRoot);
          let checkpoint: ExecutionCheckpoint | undefined;
          let finished = false;
          let nativeRecovery: Awaited<ReturnType<NonNullable<typeof adapter.recover>>> | undefined;
          try {
          const informationOnly = Boolean((job.payload.context as { informationTask?: unknown } | undefined)?.informationTask);
          const credentialIds = !informationOnly && Array.isArray(job.payload.credentialIds) ? job.payload.credentialIds : [];
          for (const credentialId of credentialIds) {
            if (typeof credentialId !== "string" || await credentialStore.get(credentialId)) continue;
            const credential = await client.claimCredential(credentialId);
            await credentialStore.put(credentialId, credential.value);
          }
          if (job.kind === "collaboration.turn") {
            const context = collaborationContextSchema.parse(job.payload.context);
            if (context.informationTask) context.localDiscovery = await discoverProject(config.projectRoot);
            const planned = context.lifecycle?.contributions.find((item) => item.participantId === context.participant.id)?.baseline;
            const runs: import("@seam/protocol").CommandEvidence[] = [];
            const collect = (record: Parameters<typeof captureCommand>[0], source: import("@seam/protocol").CommandEvidence["source"]) => { const run = captureCommand(record, config.projectRoot, source); if (run) runs.push(run); };
            const saved = context.lifecycle?.phase === "executing" ? await journal.checkpoint(context.collaborationId) : null;
            const same = (a: typeof before | undefined, b: typeof before | undefined) => Boolean(a && b && a.head === b.head && a.treeHash === b.treeHash);
            if(recovering && adapter.recover){
              nativeRecovery=await adapter.recover({context,projectRoot:config.projectRoot,signal:controller.signal,onCommand:record=>collect(record,"codex-app-server"),onTelemetry:()=>{}});
              const isImplementation=context.lifecycle?.phase==="executing";
              if(nativeRecovery.state!=="completed" && (isImplementation||context.lifecycle?.phase==="joint_verifying")){
                if(isImplementation && nativeRecovery.state==="interrupted" && context.lifecycle?.approvedHash && planned && before)checkpoint={revision:context.lifecycle.revision,approvedHash:context.lifecycle.approvedHash,approvedBaseline:planned,current:before,state:"recoverable",jobId:job.id};
                result={agentTurn:{message:nativeRecovery.reason,kind:"status",actions:[{type:"workflow.blocked",revision:context.lifecycle!.revision,kind:"needs_admin",requiresReview:true,category:nativeRecovery.state==="interrupted"?"environment":"unknown",reason:`实施中断核对：${nativeRecovery.reason}；原任务${job.id}，原生回合${nativeRecovery.turnId??"未确认"}，当前代码指纹${before?.treeHash??"无法核对"}。管理员确认后才继续原批准范围。`,dependencyParticipantIds:[],retryAfterSeconds:5}],notifyParticipantIds:[],needsHumanInput:false},recovery:{...nativeRecovery,readOnly:true,workspace:before,approvedHash:context.lifecycle?.approvedHash,observedCommandIds:runs.map(run=>run.id)}};
                return;
              }
              if(nativeRecovery.state==="unresolved")throw new Error(nativeRecovery.reason);
            }
            const resuming = Boolean(saved?.state === "recoverable" && saved.revision === context.lifecycle?.revision && saved.approvedHash === context.lifecycle?.approvedHash && same(saved.approvedBaseline, planned) && same(saved.current, before));
            if (!context.informationTask && context.lifecycle?.phase === "executing" && planned && !same(planned, before) && !resuming && nativeRecovery?.state!=="completed") {
              result = { agentTurn: { message: "工作区基线已变化或无法核对，已停止实施，请核对基线并重新批准。", actions: [{ type: "execution.report", revision: context.lifecycle.revision, status: "failed", category: "code", summary: before ? "批准文档对应的代码基线已变化，未执行代码修改。" : "当前工作区基线无法读取，不能核对已批准版本，未执行代码修改。", evidence: { planned, current: before } }] } };
              return;
            }
            if (!context.informationTask && context.lifecycle?.phase === "executing" && context.lifecycle.approvedHash && before && planned) {
              checkpoint = { revision: context.lifecycle.revision, approvedHash: context.lifecycle.approvedHash, approvedBaseline: planned, current: before, state: "running", jobId: job.id };
              await journal.saveCheckpoint(context.collaborationId, checkpoint);
            }
            let testFiles: Awaited<ReturnType<typeof collectTestFiles>> | undefined;
            if (!context.informationTask && context.lifecycle?.phase === "joint_verifying") {
              testFiles = await collectTestFiles(config.projectRoot);
              try { checkPinnedTests(context.lifecycle.reports.find(row => row.participantId === context.participant.id)?.testFiles, testFiles, context); }
              catch (error) { result = { agentTurn: { message: (error as Error).message, kind: "status", actions: [{ type: "workflow.blocked", revision: context.lifecycle.revision, kind: "needs_admin", requiresReview: true, category: "code", reason: (error as Error).message }] } }; return; }
            }
            const independentResults = await runIndependentChecks(context, config.codexNetworkAccess === true || !["codex", "codex-app-server"].includes(config.adapter), controller.signal);
            if (!context.informationTask && !context.lifecycle?.paused && context.lifecycle?.phase === "joint_verifying" && process.env.SEAM_TEST_COMMAND && !independentResults.some(row => row.status === "not_run")) {
              await runLocalTest(config.projectRoot, controller.signal, { SEAM_SERVICE_URL: context.lifecycle.services[0]?.baseUrl ?? "", SEAM_REVISION: String(context.lifecycle.revision) }, (record) => collect(record, "local-test"));
              context.lifecycle.evidenceRuns.push(...runs.map((run) => ({ ...run, participantId: context.participant.id })));
            }
            let telemetry: import("@seam/protocol").AdapterTelemetry | undefined;
            const input = { context, signal: controller.signal, projectRoot: config.projectRoot, resuming, onCommand: (record: Parameters<typeof captureCommand>[0]) => collect(record, "codex-app-server"),
              onTelemetry: (record: import("@seam/protocol").AdapterTelemetry) => { telemetry = record; }, jobPayloadHash: createHash("sha256").update(JSON.stringify(job.payload)).digest("hex") };
            const automatic = nativeRecovery?.result ?? await verifyExecutionReuse(context, config.projectRoot) ?? await verifyCachedFact(context, config.projectRoot)
              ?? (!context.informationTask && context.lifecycle?.phase === "joint_verifying" ? buildConfiguredIntegrationReport(context, process.env.SEAM_TEST_COMMAND, runs, independentResults) : null);
            const agentTurn = assertOutboundPolicy(automatic ?? await adapter.run(input), config.projectRoot);
            await fingerprintInformation(agentTurn, config.projectRoot);
            for (const action of agentTurn.actions) {
              if (action.type === "execution.report" || action.type === "integration.report") {
                const after = await collectTestFiles(config.projectRoot);
                try {
                  checkPinnedTests(action.type === "integration.report" ? testFiles : planned?.testFiles, after, context, action.type === "execution.report");
                  action.testFiles = after;
                  for (const run of runs) run.testFiles = after;
                  if (action.type === "integration.report") action.independentResults = independentResults;
                } catch (error) {
                  agentTurn.message = (error as Error).message;
                  agentTurn.actions = [{ type: "workflow.blocked", revision: context.lifecycle!.revision, kind: "needs_admin", requiresReview: true, category: "code", reason: (error as Error).message, dependencyParticipantIds: [], retryAfterSeconds: 5 }];
                  break;
                }
              }
            }
            attachCommandEvidence(agentTurn, context, runs);
            try { await probeServices(agentTurn, controller.signal, context); }
            catch (error) {
              if (!(error instanceof ServiceReadinessError) || !context.lifecycle) throw error;
              agentTurn.actions = [{ type: "workflow.blocked", revision: context.lifecycle.revision, kind: "retryable", reason: error.message, dependencyParticipantIds: [], retryAfterSeconds: 5 }];
              agentTurn.message = error.message;
            }
            for (const action of agentTurn.actions) if ((action.type === "plan.submit" || action.type === "plan.amend") && before) action.baseline = { ...before, testFiles: await collectTestFiles(config.projectRoot) };
            const conversation = await adapter.getConversation?.(input);
            result = { agentTurn, ...(nativeRecovery?{recovery:{state:nativeRecovery.state,threadId:nativeRecovery.threadId,turnId:nativeRecovery.turnId,reason:nativeRecovery.reason,readOnly:true}}:{}), provenance:{connector:build,platform:(job.payload.provenance as {platform?:unknown}|undefined)?.platform??null,protocolVersion:CONNECTOR_PROTOCOL_VERSION,jobPayloadHash:input.jobPayloadHash}, ...(conversation ? { conversation } : {}), ...(telemetry ? { telemetry } : {}) };
            finished = !agentTurn.needsHumanInput && agentTurn.actions.some((action) => action.type === "execution.report" && action.status === "passed");
          } else if (job.kind === "a2a.message") {
            const response = await a2a.transport.handle(job.payload.request);
            if (Symbol.asyncIterator in Object(response)) throw new Error("Connector 不支持流式 A2A 请求");
            result = { response };
          } else if (job.kind === "local.test") {
            result = { testRun: await runLocalTest(config.projectRoot, controller.signal) };
          } else {
            const agentTurn = assertOutboundPolicy(await adapter.run({ prompt: "检查当前项目健康状态，不要修改文件。", signal: controller.signal, projectRoot: config.projectRoot }), config.projectRoot);
            result = { agentTurn };
          }
          if (result) {
            const workspace = { before, after: await workspaceBaseline(config.projectRoot) };
            result.workspace = workspace;
            const turn = result.agentTurn as { actions?: import("@seam/protocol").AgentAction[] } | undefined;
            for (const action of turn?.actions ?? []) {
              if (action.type === "execution.report") action.evidence = { ...action.evidence, workspace };
            }
            if ((job.payload.context as { lifecycle?: { phase?: string }; informationTask?: unknown } | undefined)?.lifecycle?.phase === "joint_verifying"
              && !(job.payload.context as { informationTask?: unknown }).informationTask && workspace.before && workspace.after
              && (workspace.before.head !== workspace.after.head || workspace.before.treeHash !== workspace.after.treeHash)) {
              result.agentTurn = { message: "联合验收期间工作区发生变化，已丢弃本次通过结论，请先核对差异并重新起草、批准。", kind: "status", actions: [{ type: "workflow.blocked", revision: (job.payload.context as { lifecycle: { revision: number } }).lifecycle.revision,
                kind: "needs_admin", requiresReview: true, category: "code", reason: "联合验收期间工作区指纹变化；当前命令和独立HTTP结果不能证明最终代码版本，未发布通过结论。", dependencyParticipantIds: [], retryAfterSeconds: 5 }] };
            }
          }
          } finally {
            if (checkpoint && job.collaborationId) {
              const current = await workspaceBaseline(config.projectRoot);
              await journal.saveCheckpoint(job.collaborationId, { ...checkpoint, current, state: current ? finished ? "completed" : "recoverable" : "running" });
            }
          }
        }, config.workspaceLockDir);
      } catch (error) {
        executionError = error instanceof Error ? error.message : String(error);
      }
      // A rejected/lost completion is a delivery failure, not a second local
      // execution failure. Never send a contradictory second receipt.
      phase = `提交任务 ${job.id} 回执`;
      clearTimeout(active.leaseTimer);
      if (controller.signal.aborted) {
        const control: ControlReceipt = { jobId: job.id, attempts: job.attempts, state: "pending" };
        await journal.saveControl(control);
        try { await deliverControl(control); } catch { /* Durable pending control is replayed independently of the old completion. */ }
      }
      active = undefined;
      if(result&&job.kind==="collaboration.turn")result.provenance={connector:build,platform:(job.payload.provenance as {platform?:unknown}|undefined)?.platform??null,protocolVersion:CONNECTOR_PROTOCOL_VERSION,jobPayloadHash:createHash("sha256").update(JSON.stringify(job.payload)).digest("hex")};
      const receipt: JournalEntry = { jobId: job.id, attempts: job.attempts, recoveryKey, state: "pending", result, error: executionError, updatedAt: new Date().toISOString() };
      await journal.save(receipt);
      await deliver(receipt);
    } catch (error) {
      console.error(`Connector ${phase}失败`, error instanceof Error ? error.message : error);
      if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
    if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  } while (!config.once);
  } finally { if (active) { clearTimeout(active.leaseTimer); active.controller.abort(); } heartbeatStopped = true; clearInterval(heartbeatTimer); heartbeatController?.abort(); }
}

export { createA2AHandler } from "./a2a.js";
export { PlatformClient } from "./client.js";
export { CredentialStore } from "./credential-store.js";
export { assertOutboundPolicy } from "./outbound-policy.js";
export { readConfig } from "./config.js";
