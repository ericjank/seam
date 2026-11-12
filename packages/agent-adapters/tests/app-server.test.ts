import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collaborationContextSchema, type CollaborationContext } from "@seam/protocol";
import { buildPrompt, codexNetworkForTurn, codexSandboxForTurn, createAgentAdapter } from "../src/index";

const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function context(): CollaborationContext {
  return collaborationContextSchema.parse({
    jobId: crypto.randomUUID(), collaborationId: crypto.randomUUID(), title: "App Server 验证", type: "custom", status: "negotiating", objective: "本机持久协作",
    participant: { id: crypto.randomUUID(), projectId: crypto.randomUUID(), projectName: "项目一", agentId: null, agentName: null, role: "participant", approvalRequired: true, status: "active" },
    participants: [], messages: [], artifacts: [], workItems: [],
    lifecycle: { revision: 1, phase: "planning", requirements: "合成测试", document: null, documentHash: null, approvedHash: null, requiredParticipantIds: [], contributions: [], confirmations: [], reports: [], report: null },
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "seam-app-server-"));
  temporary.push(directory);
  const stateDir = join(directory, "sessions");
  const command = join(directory, "fake-codex.mjs");
  await writeFile(command, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(directory)};
if (process.argv.includes('--version')) { console.log('fake-codex 2'); process.exit(0); }
const log = (data) => appendFileSync(root + '/calls.jsonl', JSON.stringify(data) + '\\n');
const dbPath = root + '/threads.json';
const db = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, 'utf8')) : {};
const save = () => writeFileSync(dbPath, JSON.stringify(db));
const send = (data) => console.log(JSON.stringify(data));
let complete;
let remaining = new Set();
createInterface({input: process.stdin}).on('line', line => {
 const msg = JSON.parse(line);
 if (!msg.method) {
  log({method:'client-response', id:msg.id, result:msg.result, error:msg.error});
  remaining.delete(msg.id);
  if (!remaining.size && complete) { const fn=complete; complete=undefined; fn(); }
  return;
 }
 log({method:msg.method, params:msg.params, tokenPresent:Boolean(process.env.SEAM_AGENT_TOKEN)});
 const respond = result => send({id:msg.id,result});
 if (msg.method==='initialize') respond({userAgent:'test'});
 if (msg.method==='thread/name/set') respond({});
 if (msg.method==='thread/start') {
  const id='thread-'+Object.keys(db).length; db[id]={turns:0}; save(); respond({thread:{id,status:{type:'idle'}}});
 }
 if (msg.method==='thread/resume') {
  if (process.env.SEAM_FAKE_RESUME_FAIL) send({id:msg.id,error:{code:-32600,message:'private diagnostic'}});
  else respond({thread:{id:msg.params.threadId,status:{type:'idle'}}});
 }
 if (msg.method==='turn/start') {
  const threadId=msg.params.threadId; const current=db[threadId]; current.turns++; save();
  const turnId='turn-'+current.turns; respond({turn:{id:turnId,status:'inProgress'}});
  if (process.env.SEAM_FAKE_HOLD) return;
  const finish=()=>setTimeout(()=>{
   const data={threadId,turnNumber:current.turns,sandbox:msg.params.sandboxPolicy,tokenPresent:Boolean(process.env.SEAM_AGENT_TOKEN)};
   const item={type:'agentMessage',id:'message-'+turnId,text:process.env.SEAM_FAKE_RAW_REPLY ?? JSON.stringify({message:JSON.stringify(data),kind:'status',actions:[],notifyParticipantIds:[],needsHumanInput:false})};
   if (process.env.SEAM_FAKE_COMPACT && process.env.SEAM_FAKE_COMPACT!=='after-completed') {
    // A foreign thread's compaction must not invalidate this handoff.
    const compactThread=process.env.SEAM_FAKE_COMPACT==='foreign'?'another-thread':threadId;
    if (process.env.SEAM_FAKE_COMPACT==='legacy') send({method:'thread/compacted',params:{threadId:compactThread,turnId}});
    else send({method:'item/completed',params:{threadId:compactThread,turnId,item:{type:'contextCompaction',id:'compact-'+turnId}}});
   }
   send({method:'item/completed',params:{threadId,turnId,item:{type:'commandExecution',id:'command',aggregatedOutput:'private source'}}});
   send({method:'item/completed',params:{threadId,turnId,item}});
   const completed={method:'turn/completed',params:{threadId,turn:{id:turnId,status:process.env.SEAM_FAKE_FAIL?'failed':'completed',items:[item]}}};
   if (process.env.SEAM_FAKE_COMPACT==='after-completed') {
    // Emit both notifications in one write, with compaction after completion.
    const compacted={method:'thread/compacted',params:{threadId,turnId}};
    process.stdout.write(JSON.stringify(completed)+'\\n'+JSON.stringify(compacted)+'\\n');
   } else send(completed);
  },25);
  if (process.env.SEAM_FAKE_APPROVALS) {
   complete=finish;
   ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request','unsupported/request','execCommandApproval','applyPatchApproval'].forEach((method,index)=>{
    const id='server-'+index; remaining.add(id); send({id,method,params:{threadId,turnId}});
   });
  } else finish();
 }
 if (msg.method==='turn/interrupt') {
  respond({});
  send({method:'turn/completed',params:{threadId:msg.params.threadId,turn:{id:msg.params.turnId,status:'interrupted',items:[]}}});
 }
});
`);
  await chmod(command, 0o700);
  vi.stubEnv("SEAM_CODEX_COMMAND", command);
  vi.stubEnv("SEAM_AGENT_TOKEN", "private-control-token");
  const calls = async () => (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const adapter = () => createAgentAdapter("codex-app-server", { codexSandbox: "workspace-write", appServerStateDir: stateDir });
  return { directory, stateDir, calls, adapter };
}

describe("Codex App Server 持久会话", () => {
  it("首次start、跨实例resume保持同一thread，重复job不重复执行且映射为私有权限", async () => {
    const f = await fixture();
    const value = context();
    const first = JSON.parse((await f.adapter().run({ projectRoot: f.directory, context: value })).message);
    const next = { ...value, jobId: crypto.randomUUID() };
    const second = JSON.parse((await f.adapter().run({ projectRoot: f.directory, context: next })).message);
    expect(second).toMatchObject({ threadId: first.threadId, turnNumber: 2, tokenPresent: false, sandbox: { type: "readOnly", networkAccess: false } });
    const cached = JSON.parse((await f.adapter().run({ projectRoot: f.directory, context: next })).message);
    expect(cached).toEqual(second);
    const changed = { ...next, lifecycle: { ...next.lifecycle!, requirements: "claim时已更新的需求" } };
    expect(JSON.parse((await f.adapter().run({ projectRoot: f.directory, context: changed })).message).turnNumber).toBe(3);
    expect(JSON.parse((await f.adapter().run({ projectRoot: f.directory, context: changed, jobPayloadHash: "changed-claimed-payload" })).message).turnNumber).toBe(4);
    const calls = await f.calls();
    expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(3);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(4);
    const files = await readdir(f.stateDir);
    expect(files).toHaveLength(1);
    expect((await stat(join(f.stateDir, files[0]!))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(cached)).not.toContain("private source");
    expect(await f.adapter().getConversation?.({ projectRoot: f.directory, context: value })).toEqual({ threadId: first.threadId, transport: "codex-app-server" });
  });

  it("同一协作参与方并发调用串行，其他参与方使用独立线程", async () => {
    const f = await fixture();
    const value = context();
    const results = await Promise.all([1,2,3].map(() => f.adapter().run({ projectRoot: f.directory, context: { ...value, jobId: crypto.randomUUID() } })));
    // realpath is asynchronous; call-entry order is not a scheduling promise.
    // All requests must still use one thread and distinct sequential turns.
    expect(results.map((result) => JSON.parse(result.message).turnNumber).sort()).toEqual([1,2,3]);
    expect(new Set(results.map((result) => JSON.parse(result.message).threadId)).size).toBe(1);
    const other = await f.adapter().run({ projectRoot: f.directory, context: { ...value, participant: { ...value.participant, id: crypto.randomUUID() } } });
    expect(JSON.parse(other.message).threadId).not.toBe(JSON.parse(results[0]!.message).threadId);
  });

  it("native schema通过turn/start传递，跨实例仅发送变更资料且成功后保存哈希checkpoint", async () => {
    const f = await fixture();
    const value = context();
    value.lifecycle!.document = "只有第一轮需要发送的完整共同文档。".repeat(40);
    await f.adapter().run({ projectRoot: f.directory, context: value });
    const next = { ...value, jobId: crypto.randomUUID() };
    await f.adapter().run({ projectRoot: f.directory, context: next });
    const turns = (await f.calls()).filter((call) => call.method === "turn/start");
    expect(turns[0].params.outputSchema.type).toBe("object");
    expect(JSON.stringify(turns[0].params.outputSchema)).toContain('"const":"plan.submit"');
    const firstPrompt = turns[0].params.input[0].text;
    const nextPrompt = turns[1].params.input[0].text;
    expect(firstPrompt).toContain(value.lifecycle.document);
    expect(nextPrompt).not.toContain(value.lifecycle.document);
    expect(nextPrompt.length).toBeLessThan(firstPrompt.length);
    expect(firstPrompt).not.toContain("JSON Schema");
    expect(firstPrompt).not.toContain('"additionalProperties"');
    expect(nextPrompt).toContain(next.jobId);
    const [file] = await readdir(f.stateDir);
    const stored = JSON.parse(await readFile(join(f.stateDir, file!), "utf8"));
    expect(stored.lastHandoff).toMatchObject({ version: 2, scope: `${value.collaborationId}:${value.participant.id}` });
    expect(Object.values(stored.lastHandoff.sections).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(JSON.stringify(stored.lastHandoff)).not.toContain(value.lifecycle.document);
  });

  it("旧session缓存缺少handoff版本会重新完整同步，失败/非法回复不能前推checkpoint", async () => {
    const f = await fixture();
    const value = context();
    value.lifecycle!.document = "迁移时必须完整重新交接的共同文档";
    await f.adapter().run({ projectRoot: f.directory, context: value });
    const [file] = await readdir(f.stateDir);
    const path = join(f.stateDir, file!);
    const stored = JSON.parse(await readFile(path, "utf8"));
    delete stored.lastHandoff;
    // Fingerprint used by the previous adapter, before protocol handoff v1.
    stored.lastInputHash = createHash("sha256").update(JSON.stringify({ context: value, prompt: null, jobPayloadHash: null, sandbox: "read-only", networkAccess: false })).digest("hex");
    await writeFile(path, JSON.stringify(stored));
    await f.adapter().run({ projectRoot: f.directory, context: value });
    let turns = (await f.calls()).filter((call) => call.method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[1].params.input[0].text).toContain(value.lifecycle.document);
    const saved = await readFile(path, "utf8");
    const changed = { ...value, jobId: crypto.randomUUID(), lifecycle: { ...value.lifecycle!, requirements: "新的需求不能在失败时被记为已交接。" } };
    vi.stubEnv("SEAM_FAKE_RAW_REPLY", "纯文本不是原生结构化回执");
    await expect(f.adapter().run({ projectRoot: f.directory, context: changed })).rejects.toThrow("未返回有效结构化 JSON");
    expect(await readFile(path, "utf8")).toBe(saved);
    vi.stubEnv("SEAM_FAKE_RAW_REPLY", JSON.stringify({ message: "错误版本", kind: "status", actions: [{ type: "plan.submit", revision: 99, content: "错误版本的方案".repeat(30) }], notifyParticipantIds: [], needsHumanInput: false }));
    await expect(f.adapter().run({ projectRoot: f.directory, context: changed })).rejects.toThrow("revision/documentHash");
    expect(await readFile(path, "utf8")).toBe(saved);
    vi.unstubAllEnvs();
    const priorLength = turns[1].params.input[0].text.length;
    vi.stubEnv("SEAM_CODEX_COMMAND", join(f.directory, "fake-codex.mjs"));
    await f.adapter().run({ projectRoot: f.directory, context: changed });
    turns = (await f.calls()).filter((call) => call.method === "turn/start");
    expect(turns.at(-1).params.input[0].text).toContain(changed.lifecycle.requirements);
    expect(turns.at(-1).params.input[0].text.length).toBeLessThan(priorLength + 200);
  });

  it.each(["item", "legacy"])("当轮%s compaction后仅下个新job全量重同步，同job仍命中成功缓存", async (mode) => {
    const f = await fixture();
    const value = context();
    value.lifecycle!.document = "压缩后不可仅依赖摘要的完整审批方案".repeat(20);
    vi.stubEnv("SEAM_FAKE_COMPACT", mode);
    const first = await f.adapter().run({ projectRoot: f.directory, context: value });
    const [file] = await readdir(f.stateDir);
    expect(JSON.parse(await readFile(join(f.stateDir, file!), "utf8"))).not.toHaveProperty("lastHandoff");
    expect(await f.adapter().run({ projectRoot: f.directory, context: value })).toEqual(first);
    expect((await f.calls()).filter((call) => call.method === "turn/start")).toHaveLength(1);
    vi.stubEnv("SEAM_FAKE_COMPACT", "");
    await f.adapter().run({ projectRoot: f.directory, context: { ...value, jobId: crypto.randomUUID() } });
    const turns = (await f.calls()).filter((call) => call.method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[1].params.input[0].text).toContain(value.lifecycle.document);
    expect(JSON.parse(await readFile(join(f.stateDir, file!), "utf8"))).toHaveProperty("lastHandoff");
  });

  it.each([
    { mode: "item", outcome: "failed" },
    { mode: "legacy", outcome: "failed" },
    { mode: "item", outcome: "invalidJSON" },
    { mode: "legacy", outcome: "invalidJSON" },
  ])("$mode compaction后$outcome只清除旧checkpoint，保留成功缓存并完整重试失败job", async ({ mode, outcome }) => {
    const f = await fixture();
    const value = context();
    value.lifecycle!.document = "失败前已经交接且压缩后必须完整恢复的文档 FAILED_COMPACTION_DOCUMENT".repeat(20);
    const first = await f.adapter().run({ projectRoot: f.directory, context: value });
    const [file] = await readdir(f.stateDir);
    const path = join(f.stateDir, file!);
    const before = JSON.parse(await readFile(path, "utf8"));
    expect(before).toHaveProperty("lastHandoff");
    const failed = { ...value, jobId: crypto.randomUUID(), lifecycle: { ...value.lifecycle!, requirements: "失败轮次的新资料不得前推成功baseline。" } };
    vi.stubEnv("SEAM_FAKE_COMPACT", mode);
    if (outcome === "failed") vi.stubEnv("SEAM_FAKE_FAIL", "1");
    else vi.stubEnv("SEAM_FAKE_RAW_REPLY", "压缩后返回的非法JSON");
    await expect(f.adapter().run({ projectRoot: f.directory, context: failed })).rejects.toThrow(
      outcome === "failed" ? "轮次未完成" : "未返回有效结构化 JSON",
    );
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after).not.toHaveProperty("lastHandoff");
    expect(after).toMatchObject({
      lastTurnId: before.lastTurnId, lastJobId: before.lastJobId,
      lastInputHash: before.lastInputHash, lastResult: before.lastResult,
    });
    expect(after.lastJobId).not.toBe(failed.jobId);
    // Lost delivery of the previous successful receipt still reuses its cache,
    // even while the next attempted job failed after compaction.
    expect(await f.adapter().run({ projectRoot: f.directory, context: value })).toEqual(first);
    expect((await f.calls()).filter((call) => call.method === "turn/start")).toHaveLength(2);
    vi.stubEnv("SEAM_FAKE_COMPACT", "");
    vi.stubEnv("SEAM_FAKE_FAIL", "");
    vi.stubEnv("SEAM_FAKE_RAW_REPLY", JSON.stringify({ message: "失败后完整重新交接。", kind: "status", actions: [], notifyParticipantIds: [], needsHumanInput: false }));
    await f.adapter().run({ projectRoot: f.directory, context: failed });
    const turns = (await f.calls()).filter((call) => call.method === "turn/start");
    expect(turns).toHaveLength(3);
    expect(turns[1].params.input[0].text).not.toContain(value.lifecycle.document);
    expect(turns[2].params.input[0].text).toContain(value.lifecycle.document);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ lastJobId: failed.jobId });
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("lastHandoff");
  });

  it("completed后同一stdout块的compaction仍清checkpoint，同成功job重投不再次执行", async () => {
    const f = await fixture();
    const value = context();
    value.lifecycle!.document = "完成事件后才到达的压缩通知也必须恢复完整文档 LATE_COMPACTION_DOCUMENT".repeat(20);
    await f.adapter().run({ projectRoot: f.directory, context: value });
    const compacted = { ...value, jobId: crypto.randomUUID() };
    vi.stubEnv("SEAM_FAKE_COMPACT", "after-completed");
    const result = await f.adapter().run({ projectRoot: f.directory, context: compacted });
    const [file] = await readdir(f.stateDir);
    const path = join(f.stateDir, file!);
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("lastHandoff");
    expect(await f.adapter().run({ projectRoot: f.directory, context: compacted })).toEqual(result);
    expect((await f.calls()).filter((call) => call.method === "turn/start")).toHaveLength(2);
    vi.stubEnv("SEAM_FAKE_COMPACT", "");
    await f.adapter().run({ projectRoot: f.directory, context: { ...value, jobId: crypto.randomUUID() } });
    const turns = (await f.calls()).filter((call) => call.method === "turn/start");
    expect(turns).toHaveLength(3);
    expect(turns[1].params.input[0].text).not.toContain(value.lifecycle.document);
    expect(turns[2].params.input[0].text).toContain(value.lifecycle.document);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("lastHandoff");
  });

  it("其他thread的compaction不清除本方checkpoint", async () => {
    const f = await fixture();
    vi.stubEnv("SEAM_FAKE_COMPACT", "foreign");
    await f.adapter().run({ projectRoot: f.directory, context: context() });
    const [file] = await readdir(f.stateDir);
    expect(JSON.parse(await readFile(join(f.stateDir, file!), "utf8"))).toHaveProperty("lastHandoff");
  });

  it("后台审批请求全部拒绝或空回答，未知请求返回错误且不会挂死", async () => {
    const f = await fixture();
    vi.stubEnv("SEAM_FAKE_APPROVALS", "1");
    await f.adapter().run({ projectRoot: f.directory, context: context() });
    const replies = (await f.calls()).filter((call) => call.method === "client-response");
    expect(replies).toHaveLength(8);
    expect(replies[0].result).toEqual({ decision: "decline" });
    expect(replies[2].result).toEqual({ permissions: {}, scope: "turn" });
    expect(replies[3].result).toEqual({ answers: {} });
    expect(replies[5].error.code).toBe(-32601);
    expect(replies[6].result.decision.denied.rejection).toContain("cannot approve");
    expect(JSON.stringify(replies)).not.toContain('"accept"');
  });

  it("planning强制只读，批准当前hash的executing才允许本项目写入；恢复失败不新建替代线程", async () => {
    const f = await fixture();
    const value = context();
    const plan = JSON.parse((await f.adapter().run({ projectRoot: f.directory, context: value })).message);
    expect(plan.sandbox.type).toBe("readOnly");
    const hash = "a".repeat(64);
    const approved = { ...value, jobId: crypto.randomUUID(), lifecycle: { ...value.lifecycle!, phase: "executing" as const, documentHash: hash, approvedHash: hash } };
    const write = JSON.parse((await f.adapter().run({ projectRoot: f.directory, context: approved })).message);
    expect(write.sandbox).toEqual({ type: "workspaceWrite", writableRoots: [await realpath(f.directory)], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    const online = createAgentAdapter("codex-app-server", { codexSandbox: "workspace-write", appServerStateDir: f.stateDir, codexNetworkAccess: true });
    expect(JSON.parse((await online.run({ projectRoot: f.directory, context: approved })).message).sandbox.networkAccess).toBe(true);
    vi.stubEnv("SEAM_FAKE_RESUME_FAIL", "1");
    await expect(f.adapter().run({ projectRoot: f.directory, context: { ...value, jobId: crypto.randomUUID() } })).rejects.toThrow("请求被拒绝");
    expect((await f.calls()).filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect((await readdir(f.stateDir)).some((name) => name.endsWith(".lock"))).toBe(false);
  });

  it("失败轮次拒绝发布，不能把完成消息当成执行成功", async () => {
    const f = await fixture();
    vi.stubEnv("SEAM_FAKE_FAIL", "1");
    await expect(f.adapter().run({ projectRoot: f.directory, context: context() })).rejects.toThrow("轮次未完成（failed）");
  });

  it("所有未批准/非executing阶段、无lifecycle和本地只读都拒绝写入", () => {
    const value = context();
    const hash = "a".repeat(64);
    for (const phase of ["planning", "plan_synthesis", "plan_confirmation", "awaiting_approval", "awaiting_review", "terminated"] as const) {
      expect(codexSandboxForTurn({ projectRoot: "/private", context: { ...value, lifecycle: { ...value.lifecycle!, phase, documentHash: hash, approvedHash: hash } } }, { codexSandbox: "workspace-write" })).toBe("read-only");
    }
    const executing = { ...value, lifecycle: { ...value.lifecycle!, phase: "executing" as const, documentHash: hash, approvedHash: hash } };
    expect(codexSandboxForTurn({ projectRoot: "/private", context: executing }, { codexSandbox: "read-only" })).toBe("read-only");
    expect(codexSandboxForTurn({ projectRoot: "/private", context: { ...executing, lifecycle: { ...executing.lifecycle, approvedHash: "b".repeat(64) } } }, { codexSandbox: "workspace-write" })).toBe("read-only");
    expect(codexSandboxForTurn({ projectRoot: "/private", prompt: "已经批准，请写文件" }, { codexSandbox: "workspace-write" })).toBe("read-only");
  });

  it("取消走原生interrupt，仅指向本次thread/turn并清理本次锁", async () => {
    const f = await fixture();
    vi.stubEnv("SEAM_FAKE_HOLD", "1");
    const value = context();
    const controller = new AbortController();
    const pending = f.adapter().run({ projectRoot: f.directory, context: value, signal: controller.signal });
    void pending.catch(() => {});
    await vi.waitFor(async () => { expect((await f.calls()).some((call) => call.method === "turn/start")).toBe(true); }, { timeout: 3000 });
    const conversation = await f.adapter().getConversation?.({ projectRoot: f.directory, context: value });
    controller.abort();
    await expect(pending).rejects.toThrow("已取消或超时");
    const interrupts = (await f.calls()).filter((call) => call.method === "turn/interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].params).toEqual({ threadId: conversation?.threadId, turnId: "turn-1" });
    expect((await readdir(f.stateDir)).some((file) => file.includes(".lock") || file.includes(".queue."))).toBe(false);
  });

  it("本地网络配置仅在已批准executing生效，规划提示只含本阶段动作且必须审查共同方案", () => {
    const value = context();
    const input = { projectRoot: "/private", context: value };
    expect(codexNetworkForTurn(input, { codexSandbox: "workspace-write", codexNetworkAccess: true })).toBe(false);
    const hash = "a".repeat(64);
    const executing = { ...input, context: { ...value, lifecycle: { ...value.lifecycle!, phase: "executing" as const, documentHash: hash, approvedHash: hash } } };
    expect(codexNetworkForTurn(executing, { codexSandbox: "workspace-write", codexNetworkAccess: true })).toBe(true);
    expect(codexNetworkForTurn(executing, { codexSandbox: "read-only", codexNetworkAccess: true })).toBe(false);
    const joint = { ...executing, context: { ...executing.context, lifecycle: { ...executing.context.lifecycle, phase: "joint_verifying" as const } } };
    expect(codexNetworkForTurn(joint, { codexSandbox: "workspace-write", codexNetworkAccess: true })).toBe(true);
    expect(codexSandboxForTurn({ ...executing, context: { ...executing.context, lifecycle: { ...executing.context.lifecycle, paused: true } } }, { codexSandbox: "workspace-write" })).toBe("read-only");
    const prompt = buildPrompt(input);
    const schemaText = prompt.split("\n").find((line) => line.startsWith("完整回复及当前阶段允许的动作 JSON Schema："))!;
    const schema = JSON.stringify(JSON.parse(schemaText.slice(schemaText.indexOf("：") + 1)));
    expect(schema).toContain('"plan.submit"');
    expect(schema).not.toContain('"execution.report"');
    expect(schema).not.toContain('"credential.request"');
    const confirmation = buildPrompt({ ...input, context: { ...value, lifecycle: { ...value.lifecycle!, phase: "plan_confirmation", documentHash: hash } } });
    expect(confirmation).toContain("不能盲目确认");
  });
});
