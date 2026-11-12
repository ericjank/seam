import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorJob } from "@seam/protocol";
import type { ConnectorConfig } from "./config.js";

export type JournalEntry = {
  jobId: string; attempts: number; state: "running" | "pending" | "acknowledged" | "rejected";
  result?: Record<string, unknown>; error?: string; rejection?: string; updatedAt: string;
};

export class ExecutionJournal {
  readonly directory: string;
  constructor(config: ConnectorConfig) {
    const scope = createHash("sha256").update(JSON.stringify([config.platformUrl, config.agentId, config.projectRoot])).digest("hex");
    this.directory = join(config.stateDir ?? join(homedir(), ".seam", "connectors"), scope);
  }
  async read(jobId: string): Promise<JournalEntry | null> {
    try { return JSON.parse(await readFile(join(this.directory, `${jobId}.json`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async save(entry: Omit<JournalEntry, "updatedAt">) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${entry.jobId}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ ...entry, updatedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(this.directory, `${entry.jobId}.json`));
  }
  async pending() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name));
    const entries = await Promise.all(files.map((name) => this.read(name.slice(0, -5))));
    return entries.filter((entry): entry is JournalEntry => entry?.state === "pending");
  }
  async begin(job: ConnectorJob) {
    const entry = await this.read(job.id);
    if (entry?.state === "running") throw new Error("此任务上次执行中断，完成状态未知。已阻止自动重复实施，请核对本地修改及日志后继续新任务。");
    if (entry) return entry;
    await this.save({ jobId: job.id, attempts: job.attempts, state: "running" });
    return null;
  }
}
