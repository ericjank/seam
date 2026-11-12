import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentTurnResultSchema, tokenUsageBreakdownSchema, type AgentTurnResult, type AdapterTelemetry } from "@seam/protocol";
import { checkCli } from "./cli.js";
import { buildNativeHandoff, materializeHandoffResources, NATIVE_HANDOFF_VERSION, type HandoffCheckpoint } from "./handoff.js";
import { parseNativeAgentOutput } from "./response-schema.js";
import { codexNetworkForTurn, codexSandboxForTurn } from "./policy.js";
import type { AdapterOptions, AgentAdapter, AgentRunInput } from "./types.js";
import { acquireSessionLock } from "./session-lock.js";

type RecordValue = Record<string, unknown>;
type Session = {
  version: 1; threadId: string; projectRoot: string; collaborationId: string; participantId: string;
  lastTurnId?: string; lastJobId?: string; lastResult?: AgentTurnResult;
  lastInputHash?: string;
  lastHandoff?: HandoffCheckpoint;
  title?: string; runLabel?: string; usageTotal?: NonNullable<AdapterTelemetry["tokenUsage"]>["threadTotal"]; lastTelemetry?: AdapterTelemetry;
};
const queues = new Map<string, Promise<void>>();
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);

/** A dedicated stdio connection. It never connects to or restarts the user's app. */
class AppServerConnection {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { method: string; resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(method: string, params: RecordValue) => void>();
  private sequence = 0;
  private buffer = "";
  private failed: Error | undefined;
  deniedRequests = 0;
  contextCompacted = false;
  tokenUsage: NonNullable<AdapterTelemetry["tokenUsage"]> | null = null;
  tokenUsageTurnId: string | undefined;

  constructor(projectRoot: string, private trackedThreadId?: string) {
    const env = { ...process.env };
    delete env.SEAM_AGENT_TOKEN;
    this.process = spawn(process.env.SEAM_CODEX_COMMAND ?? "codex", ["app-server", "--listen", "stdio://"], {
      cwd: projectRoot, env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 10 * 1024 * 1024) return this.fail(new Error("Codex App Server 协议输出超过限制"));
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); } catch { this.fail(new Error("Codex App Server 返回无效协议消息")); }
      }
    });
    // Drain local diagnostics without publishing command output or credentials.
    this.process.stderr.resume();
    this.process.stdin.on("error", () => this.fail(new Error("Codex App Server 输入连接中断")));
    this.process.on("error", () => this.fail(new Error("无法启动本机 Codex App Server，请检查 SEAM_CODEX_COMMAND")));
    this.process.on("exit", (code) => this.fail(new Error(`Codex App Server 已退出（${code ?? "signal"}）`)));
  }

  private send(value: RecordValue) {
    if (this.failed) throw this.failed;
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(value: unknown) {
    if (!isRecord(value)) return;
    if (typeof value.method === "string") {
      const params = isRecord(value.params) ? value.params : {};
      // Observe independently of turn success and the temporary turn listener.
      // A compaction may arrive after turn/completed in the same stdout chunk,
      // during resume/close, or before a failed/invalid final response.
      if (params.threadId === this.trackedThreadId) {
        if (value.method === "thread/tokenUsage/updated" && isRecord(params.tokenUsage)) {
          const total = tokenUsageBreakdownSchema.safeParse(params.tokenUsage.total), last = tokenUsageBreakdownSchema.safeParse(params.tokenUsage.last);
          if (total.success && last.success && typeof params.turnId === "string") { this.tokenUsage = { threadTotal: total.data, lastModelCall: last.data, turnDelta: null }; this.tokenUsageTurnId = params.turnId; }
        }
        const items = isRecord(params.turn) && Array.isArray(params.turn.items) ? params.turn.items : [];
        if (value.method === "thread/compacted"
          || (value.method === "item/completed" && isRecord(params.item) && params.item.type === "contextCompaction")
          || items.some((item) => isRecord(item) && item.type === "contextCompaction")) this.contextCompacted = true;
      }
      if (value.id !== undefined) {
        this.deniedRequests += 1;
        // Never grant interactive approvals on a background Connector channel.
        let result: unknown;
        switch (value.method) {
          case "item/commandExecution/requestApproval":
          case "item/fileChange/requestApproval": result = { decision: "decline" }; break;
          case "execCommandApproval":
          case "applyPatchApproval": result = { decision: { denied: { rejection: "Seam unattended Connector cannot approve interactive requests" } } }; break;
          case "item/permissions/requestApproval": result = { permissions: {}, scope: "turn" }; break;
          case "item/tool/requestUserInput":
          case "tool/requestUserInput": result = { answers: {} }; break;
          case "mcpServer/elicitation/request": result = { action: "decline", content: null }; break;
          default:
            this.send({ id: value.id, error: { code: -32601, message: "Seam unattended Connector does not support interactive server requests" } });
            return;
        }
        this.send({ id: value.id, result });
        return;
      }
      for (const listener of this.listeners) listener(value.method, params);
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (isRecord(value.error)) pending.reject(new Error(`Codex App Server ${pending.method} 请求被拒绝（错误码 ${String(value.error.code ?? "unknown")}）`));
    else if (isRecord(value.result)) pending.resolve(value.result);
    else pending.reject(new Error("Codex App Server 响应缺少结果"));
  }

  private fail(error: Error) {
    if (this.failed) return;
    this.failed = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener("connection/failed", {});
  }

  request(method: string, params: RecordValue, timeoutMs = 60_000): Promise<RecordValue> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveRequest, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "seam_connector", title: "Seam Connector", version: "0.1.0" }, capabilities: { experimentalApi: false } });
    this.send({ method: "initialized", params: {} });
  }

  async turn(threadId: string, params: RecordValue, signal?: AbortSignal, onCommand?: AgentRunInput["onCommand"]): Promise<{ text: string; turnId: string }> {
    this.trackedThreadId = threadId;
    let turnId: string | undefined;
    let cancellation: Promise<void> | undefined;
    let cancelled = false;
    const messages = new Map<string, string>();
    const commands = new Set<string>();
    const collectCommand = (item: RecordValue) => {
      if (item.type !== "commandExecution" || typeof item.command !== "string" || commands.has(String(item.id))) return;
      commands.add(String(item.id));
      onCommand?.({ id: String(item.id), command: item.command, exitCode: typeof item.exitCode === "number" ? item.exitCode : null, output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "" });
    };
    let finish!: (value: { text: string; turnId: string }) => void;
    let rejectTurn!: (error: Error) => void;
    const done = new Promise<{ text: string; turnId: string }>((resolveTurn, reject) => { finish = resolveTurn; rejectTurn = reject; });
    // A response and notifications may arrive in the same stdout chunk. Install
    // this collector before turn/start and scope everything to this thread.
    const onEvent = (method: string, event: RecordValue) => {
      if (method === "connection/failed") { rejectTurn(this.failed ?? new Error("Codex App Server 连接中断")); return; }
      if (event.threadId !== threadId) return;
      if (typeof event.turnId === "string" && turnId && event.turnId !== turnId) return;
      if (method === "item/completed" && isRecord(event.item)) collectCommand(event.item);
      if (method === "item/completed" && isRecord(event.item) && event.item.type === "agentMessage" && typeof event.item.text === "string") {
        messages.set(String(event.item.id), event.item.text);
      }
      if (method === "turn/completed" && isRecord(event.turn)) {
        const turn = event.turn;
        if (turnId && turn.id !== turnId) return;
        if (turn.status !== "completed") { rejectTurn(new Error(`Codex App Server 轮次未完成（${String(turn.status)}）`)); return; }
        // Completed-turn items are authoritative when provided. Never consume
        // reasoning or command stdout as the public Agent reply.
        const items = Array.isArray(turn.items) ? turn.items : [];
        for (const item of items) {
          if (!isRecord(item)) continue;
          collectCommand(item);
          if (item.type === "agentMessage" && typeof item.text === "string") messages.set(String(item.id), item.text);
        }
        const text = [...messages.values()].at(-1);
        if (!text || typeof turn.id !== "string") rejectTurn(new Error("Codex App Server 缺少已完成 Agent 回复"));
        else finish({ text, turnId: turn.id });
      }
    };
    this.listeners.add(onEvent);
    const interrupt = () => {
      cancelled = true;
      if (turnId && !cancellation) cancellation = this.request("turn/interrupt", { threadId, turnId }, 5000).then(() => {}, () => {});
      rejectTurn(new Error("Codex App Server 轮次已取消或超时；未发布不完整回复"));
    };
    const timer = setTimeout(interrupt, 15 * 60 * 1000);
    signal?.addEventListener("abort", interrupt, { once: true });
    // Register a handler immediately, including while waiting for turn/start.
    void done.catch(() => {});
    try {
      if (signal?.aborted) throw new Error("Codex App Server 轮次已取消");
      const response = await this.request("turn/start", { ...params, threadId });
      if (!isRecord(response.turn) || typeof response.turn.id !== "string") throw new Error("Codex App Server 未返回轮次标识");
      turnId = response.turn.id;
      if (cancelled) interrupt();
      return await done;
    } finally {
      await cancellation;
      clearTimeout(timer); signal?.removeEventListener("abort", interrupt); this.listeners.delete(onEvent);
    }
  }

  async close() {
    this.process.stdin.end();
    if (!this.process.pid) return;
    const waitForExit = () => new Promise<boolean>((resolveExit) => {
      if (this.process.exitCode !== null || this.process.signalCode !== null) { resolveExit(true); return; }
      const exited = () => { clearTimeout(timer); resolveExit(true); };
      const timer = setTimeout(() => { this.process.off("exit", exited); resolveExit(false); }, 1500);
      this.process.once("exit", exited);
    });
    if (await waitForExit()) return;
    this.process.kill("SIGTERM");
    if (await waitForExit()) return;
    this.process.kill("SIGKILL");
    if (!await waitForExit()) throw new Error("本次 Codex App Server 子进程未确认退出，请本机维护者检查后再继续该会话");
  }
}

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  const tail = previous.catch(() => {}).then(() => next);
  queues.set(key, tail);
  await previous.catch(() => {});
  try { return await operation(); } finally { release(); if (queues.get(key) === tail) queues.delete(key); }
}

export class CodexAppServerAdapter implements AgentAdapter {
  readonly type = "codex-app-server" as const;
  constructor(private options: AdapterOptions = {}) {}

  async healthCheck(projectRoot: string) {
    return checkCli(process.env.SEAM_CODEX_COMMAND ?? "codex", ["--version"], projectRoot);
  }

  async getConversation(input: AgentRunInput) {
    if (!input.context) return null;
    const projectRoot = await realpath(input.projectRoot);
    const identity = { projectRoot, collaborationId: input.context.collaborationId, participantId: input.context.participant.id };
    const directory = resolve(this.options.appServerStateDir ?? join(homedir(), ".seam", "threads"));
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, `${key}.json`), "utf8"));
      if (!isRecord(value) || value.projectRoot !== projectRoot || value.collaborationId !== identity.collaborationId || value.participantId !== identity.participantId || typeof value.threadId !== "string") throw new Error("Codex 会话映射无效");
      return { threadId: value.threadId, transport: "codex-app-server" as const, ...(typeof value.title === "string" ? { title: value.title } : {}), ...(typeof value.runLabel === "string" ? { runLabel: value.runLabel } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async run(input: AgentRunInput): Promise<AgentTurnResult> {
    if (input.signal?.aborted) throw new Error("Codex App Server 轮次已取消");
    const projectRoot = await realpath(input.projectRoot);
    const identity = input.context ? { projectRoot, collaborationId: input.context.collaborationId, participantId: input.context.participant.id } : null;
    const directory = resolve(this.options.appServerStateDir ?? join(homedir(), ".seam", "threads"));
    const key = createHash("sha256").update(JSON.stringify(identity ?? { projectRoot, oneShot: randomUUID() })).digest("hex");
    return serialize(`${directory}:${key}`, async () => {
      const path = join(directory, `${key}.json`);
      let unlock: (() => Promise<void>) | undefined;
      let session: Session | undefined;
      const inputHash = createHash("sha256").update(JSON.stringify({ handoffVersion: NATIVE_HANDOFF_VERSION, context: input.context ?? null, prompt: input.prompt ?? null, jobPayloadHash: input.jobPayloadHash ?? null, sandbox: codexSandboxForTurn(input, this.options), networkAccess: codexNetworkForTurn(input, this.options) })).digest("hex");
      if (identity) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        unlock = await acquireSessionLock(path, input.signal);
        try {
          const value: unknown = JSON.parse(await readFile(path, "utf8"));
          if (!isRecord(value) || value.version !== 1 || typeof value.threadId !== "string" || value.projectRoot !== projectRoot || value.collaborationId !== identity.collaborationId || value.participantId !== identity.participantId) throw new Error("Codex 会话映射无效；不会静默创建新线程或复用其他项目会话");
          session = value as Session;
          if (input.context?.jobId && session.lastJobId === input.context.jobId && session.lastInputHash === inputHash && session.lastResult) {
            const cached = agentTurnResultSchema.parse(session.lastResult);
            if (session.lastTelemetry) input.onTelemetry?.(session.lastTelemetry);
            await unlock();
            return cached;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await unlock(); throw error; }
        }
      }
      const connection = new AppServerConnection(projectRoot, session?.threadId);
      let attemptedTurn = false, acceptedTurn = false;
      const save = async () => {
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
        finally { await rm(temporary, { force: true }); }
      };
      try {
        const startedAt = Date.now();
        await connection.initialize();
        const sandbox = codexSandboxForTurn(input, this.options);
        const base = { cwd: projectRoot, approvalPolicy: "never", sandbox };
        const response = session
          ? await connection.request("thread/resume", { threadId: session.threadId, excludeTurns: true, ...base })
          : await connection.request("thread/start", { ...base, ephemeral: !identity, serviceName: "seam_connector" });
        if (!isRecord(response.thread) || typeof response.thread.id !== "string") throw new Error("Codex App Server 未返回会话标识");
        if (session && response.thread.id !== session.threadId) throw new Error("Codex 恢复的会话与本地映射不符");
        if (isRecord(response.thread.status) && response.thread.status.type === "active") throw new Error("Codex 会话已有进行中轮次；本次任务不会并发追加");
        if (identity && !session) {
          session = { version: 1, threadId: response.thread.id, ...identity, usageTotal: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, cacheWriteInputTokens: 0 } }; await save();
        }
        if (session) {
          const runLabel = (process.env.SEAM_RUN_LABEL ?? "").replace(/[\r\n]/g, " ").slice(0, 40);
          const short = (value: string) => value.replace(/\s+/g, " ").slice(0, 28);
          const title = `Seam${runLabel ? ` [${runLabel}]` : ""} · ${short(input.context!.title)} · ${short(input.context!.participant.projectName)} · r${input.context!.lifecycle?.revision ?? 1}`;
          if (session.title !== title) await connection.request("thread/name/set", { threadId: session.threadId, name: title }, 10_000).then(async () => { session!.title = title; session!.runLabel = runLabel; await save(); }).catch(() => {});
        }
        const prepared = await materializeHandoffResources(input, join(directory, "resources"), undefined, false);
        const handoff = buildNativeHandoff({ ...prepared, conversationMode: "persistent", localExecutionPolicy: `Codex App Server sandbox=${sandbox}，approval=never。当前策略由本地能力与平台批准的阶段交集决定；不得提升权限。` }, session?.lastHandoff);
        let commandOutputBytes = 0, resourceCommandOutputBytes = 0, resourceReadCommands = 0;
        attemptedTurn = true;
        const finished = await connection.turn(response.thread.id, {
          cwd: projectRoot, approvalPolicy: "never",
          sandboxPolicy: sandbox === "workspace-write"
            ? { type: "workspaceWrite", writableRoots: [projectRoot], networkAccess: codexNetworkForTurn(input, this.options), excludeTmpdirEnvVar: true, excludeSlashTmp: true }
            : { type: "readOnly", networkAccess: false },
          input: [{ type: "text", text: handoff.prompt }],
          outputSchema: handoff.outputSchema,
        }, input.signal, (record) => {
          const bytes = Buffer.byteLength(record.output); commandOutputBytes += bytes;
          if (record.command.includes(join(directory, "resources"))) { resourceReadCommands++; resourceCommandOutputBytes += bytes; }
          input.onCommand?.(record);
        });
        const result = parseNativeAgentOutput(finished.text, input);
        const usage = connection.tokenUsageTurnId === finished.turnId ? connection.tokenUsage : null;
        if (usage && session?.usageTotal) {
          const before = session.usageTotal, delta = Object.fromEntries(Object.entries(usage.threadTotal).map(([key, value]) => [key, value - before[key as keyof typeof before]]));
          const parsed = tokenUsageBreakdownSchema.safeParse(delta); if (parsed.success && parsed.data.totalTokens > 0) usage.turnDelta = parsed.data;
        }
        const telemetry: AdapterTelemetry = { version: 1, threadId: String(response.thread.id), turnId: finished.turnId,
          jobId: input.context?.jobId, revision: input.context?.lifecycle?.revision, phase: input.context?.lifecycle?.phase,
          promptBytes: Buffer.byteLength(handoff.prompt), schemaBytes: Buffer.byteLength(JSON.stringify(handoff.outputSchema)),
          commandOutputBytes, resourceCommandOutputBytes, resourceReadCommands, durationMs: Date.now() - startedAt,
          resourceStats: prepared.resourceStats ?? { createdBytes: 0, availableBytes: 0, files: 0, prunedFiles: 0 }, contextCompacted: connection.contextCompacted,
          ...(typeof response.model === "string" ? { model: response.model } : {}), tokenUsage: usage };
        // Telemetry is transport-observed metadata, outside the model's reply.
        const telemetryDir = join(directory, "telemetry", key); await mkdir(telemetryDir, { recursive: true, mode: 0o700 });
        await writeFile(join(telemetryDir, `${finished.turnId}.json`), JSON.stringify(telemetry), { mode: 0o600 });
        input.onTelemetry?.(telemetry);
        if (session) {
          session.lastTurnId = finished.turnId; session.lastJobId = input.context?.jobId; session.lastInputHash = inputHash; session.lastResult = result;
          session.lastTelemetry = telemetry;
          if (usage) session.usageTotal = usage.threadTotal; else delete session.usageTotal;
          // Compaction can replace exact shared facts with a summary. A later
          // turn must receive a full handoff, even though this result is valid.
          if (connection.contextCompacted) delete session.lastHandoff;
          else session.lastHandoff = handoff.checkpoint;
          await save();
        }
        acceptedTurn = true;
        return result;
      } finally {
        try { await connection.close(); }
        finally {
          try {
            // A failed/interrupted turn can consume tokens without a final
            // usage event. Never attribute that unknown cost to the next turn.
            if (session && attemptedTurn && !acceptedTurn) { delete session.usageTotal; await save(); }
            if (session?.lastHandoff && connection.contextCompacted) {
              delete session.lastHandoff;
              await save();
            }
          } finally { await unlock?.(); }
        }
      }
    });
  }
}
