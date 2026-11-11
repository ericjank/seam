import { randomUUID } from "node:crypto";
import { link, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

type Owner = { pid: number; choosing: boolean; ticket: number; file: string };
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

/**
 * Bakery tickets serialize contenders without unlinking a replacement owner's
 * lock. Dead-process tickets have unique names and can safely be reclaimed.
 * The legacy singleton is retained to interoperate with older Connectors.
 */
export async function acquireSessionLock(mappingPath: string, signal?: AbortSignal, timeoutMs = 15 * 60 * 1000) {
  const directory = dirname(mappingPath);
  const prefix = `${basename(mappingPath)}.queue.`;
  const token = randomUUID();
  const file = `${directory}/${prefix}${process.pid}.${token}.json`;
  const legacy = `${mappingPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  const wait = async () => {
    if (signal?.aborted) throw new Error("Codex 会话等待已取消");
    if (Date.now() >= deadline) throw new Error("Codex 会话正在其他 Connector 执行，等待串行队列超时");
    await new Promise<void>((resolveWait, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error("Codex 会话等待已取消")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolveWait(); }, 50);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
  const owner = async (path: string): Promise<Owner | null> => {
    const match = basename(path).slice(prefix.length).match(/^(\d+)\.[a-f0-9-]+\.json$/);
    const pid = Number(match?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (!alive(pid)) { await rm(path, { force: true }); return null; }
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as { choosing?: boolean; ticket?: number };
      return { pid, file: path, choosing: value.choosing !== false, ticket: Number.isSafeInteger(value.ticket) && value.ticket! > 0 ? value.ticket! : 0 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // An initial atomic write may still be opening its unique file.
      return { pid, file: path, choosing: true, ticket: 0 };
    }
  };
  const list = async () => {
    const paths = (await readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).map((name) => `${directory}/${name}`);
    return (await Promise.all(paths.map(owner))).filter((value): value is Owner => value !== null);
  };
  let singletonOwned = false;
  try {
    if (signal?.aborted) throw new Error("Codex 会话等待已取消");
    await writeFile(file, JSON.stringify({ pid: process.pid, choosing: true, ticket: 0 }), { mode: 0o600, flag: "wx" });
    const largest = Math.max(0, ...(await list()).map((value) => value.ticket));
    if (largest >= Number.MAX_SAFE_INTEGER) throw new Error("Codex 会话队列票号无效");
    const ticket = largest + 1;
    const temporary = `${file}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ pid: process.pid, choosing: false, ticket }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    for (const contender of await list()) {
      if (contender.file === file) continue;
      let current = await owner(contender.file);
      while (current?.choosing) { await wait(); current = await owner(contender.file); }
      while (current && (current.ticket < ticket || (current.ticket === ticket && current.file < file))) {
        await wait(); current = await owner(contender.file);
      }
    }
    // Publish a fully written singleton with link(), so a crash cannot leave
    // a new-format singleton without an identifiable owner.
    const candidate = `${file}.singleton`;
    await writeFile(candidate, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: "wx" });
    try {
      while (!singletonOwned) {
        try { await link(candidate, legacy); singletonOwned = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const raw = await readFile(legacy, "utf8");
            const value: unknown = JSON.parse(raw);
            const pid = typeof value === "number" ? value : value && typeof value === "object" && "pid" in value ? Number(value.pid) : NaN;
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("既有 Codex 会话锁缺少有效持有者，需要本机维护者核对");
            if (!alive(pid)) { await rm(legacy, { force: true }); continue; }
          } catch (readError) {
            if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw readError;
          }
          await wait();
        }
      }
    } finally { await rm(candidate, { force: true }); }
    return async () => { await rm(legacy, { force: true }); await rm(file, { force: true }); };
  } catch (error) {
    if (singletonOwned) await rm(legacy, { force: true });
    await rm(file, { force: true });
    throw error;
  }
}
