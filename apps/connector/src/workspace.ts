import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { acquireSessionLock } from "@seam/agent-adapters";
import type { z } from "zod";
import type { workspaceBaselineSchema } from "@seam/protocol";

const execFileAsync = promisify(execFile);
export async function withWorkspaceLock<T>(root: string, signal: AbortSignal, run: () => Promise<T>, directory = join(homedir(), ".seam", "workspace-locks")) {
  let canonical = await realpath(root);
  try { const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: canonical, timeout: 5000 }); canonical = await realpath(stdout.trim()); } catch {}
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${createHash("sha256").update(canonical).digest("hex")}.json`);
  const unlock = await acquireSessionLock(path, signal);
  try { if (signal.aborted) throw new Error("工作区任务已取消"); return await run(); }
  finally { await unlock(); }
}

export async function listGitWorktreeFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
    });
    return stdout.split("\0").filter(Boolean);
  } catch (error) {
    const gitError = error as NodeJS.ErrnoException & { stderr?: string };
    if (gitError.code === "ENOENT" || gitError.stderr?.startsWith("fatal: not a git repository (or any of the parent directories): .git")) return null;
    throw new Error("无法读取 Git 工作区的测试资料清单，请核对本机 Git 和工作区状态", { cause: error });
  }
}

export async function workspaceBaseline(root: string): Promise<z.infer<typeof workspaceBaselineSchema> | null> {
  try {
    const { stdout: top } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 5000 });
    const canonical = await realpath(top.trim());
    const git = (args: string[]) => execFileAsync("git", args, { cwd: canonical, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
    const [{ stdout: head }, { stdout: diff }, { stdout: untracked }] = await Promise.all([
      git(["rev-parse", "HEAD"]), git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-renames", "HEAD", "--"]), git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const files: unknown[] = [];
    for (const path of untracked.split("\0").filter(Boolean).sort()) {
      const file = join(canonical, path), info = await lstat(file);
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error("无法核对未跟踪目录");
      files.push([path, info.isSymbolicLink() ? "symlink" : "file", info.mode & 0o777,
        createHash("sha256").update(info.isSymbolicLink() ? await readlink(file) : await readFile(file)).digest("hex")]);
    }
    const hash = createHash("sha256").update("seam-workspace-v2\0").update(JSON.stringify([diff, files]));
    return { head: head.trim(), treeHash: hash.digest("hex"), capturedAt: new Date().toISOString() };
  } catch { return null; }
}
