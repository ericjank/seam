import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireSessionLock } from "../src/session-lock";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function mapping() { const directory = await mkdtemp(join(tmpdir(), "seam-session-lock-")); directories.push(directory); return join(directory, "mapping.json"); }

describe("持久会话进程锁", () => {
  it("独立调用按票号等待，不提前删除或接管仍存活owner的锁", async () => {
    const path = await mapping();
    const first = await acquireSessionLock(path);
    const original = await readFile(`${path}.lock`, "utf8");
    const pending = acquireSessionLock(path, undefined, 3000);
    const directory = directories.at(-1)!;
    await vi.waitFor(async () => { expect((await readdir(directory)).filter((name) => name.endsWith(".json") && name.includes(".queue.")).length).toBe(2); });
    expect(await readFile(`${path}.lock`, "utf8")).toBe(original);
    await first();
    const second = await pending;
    expect(await readFile(`${path}.lock`, "utf8")).not.toBe(original);
    await second();
    expect(await readdir(directory)).toEqual([]);
  });

  it("崩溃进程留下的票号和旧版PID锁可安全恢复", async () => {
    const path = await mapping();
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    expect(child.status).toBe(0);
    const deadPid = Number(child.stdout);
    await writeFile(`${path}.queue.${deadPid}.${randomUUID()}.json`, JSON.stringify({ pid: deadPid, choosing: true, ticket: 1 }));
    await writeFile(`${path}.lock`, String(deadPid));
    const release = await acquireSessionLock(path, undefined, 3000);
    await release();
    expect(await readdir(directories.at(-1)!)).toEqual([]);
  });

  it("等待取消只清理自己的票号，保留正在执行的owner", async () => {
    const path = await mapping();
    const first = await acquireSessionLock(path);
    const controller = new AbortController();
    const pending = acquireSessionLock(path, controller.signal, 3000);
    void pending.catch(() => {});
    await vi.waitFor(async () => { expect((await readdir(directories.at(-1)!)).filter((name) => name.includes(".queue.") && name.endsWith(".json"))).toHaveLength(2); });
    controller.abort();
    await expect(pending).rejects.toThrow("已取消");
    expect(JSON.parse(await readFile(`${path}.lock`, "utf8")).pid).toBe(process.pid);
    await first();
    expect(await readdir(directories.at(-1)!)).toEqual([]);
  });
});
