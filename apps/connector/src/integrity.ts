import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentTurnResult, CollaborationContext } from "@seam/protocol";

const excluded = new Set(["node_modules", "vendor", "dist", "build", "coverage", "output", "storage"]);
const privatePath = /(?:^|[\\/])(?:\.\.|\.git|\.env(?:\..*)?|credentials|id_rsa|id_ed25519)(?:$|[\\/])|\.(?:pem|key)$/i;
export async function hashProjectFile(root: string, path: string) {
  if (!path || isAbsolute(path) || privatePath.test(path)) return null;
  const canonical = await realpath(root), file = resolve(canonical, path);
  if (relative(canonical, file).startsWith("..")) return null;
  try {
    const info = await lstat(file), target = await realpath(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || relative(canonical, target).startsWith("..")) return null;
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch (error) { if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
}

export async function collectTestFiles(root: string) {
  const files: Array<{ path: string; sha256: string }> = [];
  const isTest = (path: string) => /(?:^|\/)(?:tests?|specs?|__tests__|fixtures)\//i.test(path) || /(?:\.(?:test|spec)\.[^/]+|(?:^|\/)test_[^/]+\.py|Test\.(?:php|java))$/i.test(path);
  const walk = async (directory: string, depth: number) => {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || excluded.has(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (depth < 8) await walk(path, depth + 1); continue; }
      if (!isTest(path) || privatePath.test(path)) continue;
      const sha256 = await hashProjectFile(root, path);
      if (!sha256) throw new Error(`测试资料${path}不是可核对的项目内常规文件，不能建立测试指纹`);
      files.push({ path, sha256 });
      if (files.length > 500) throw new Error("自动测试资料指纹超过500项，请将独立验收资料收敛到项目测试目录");
    }
  };
  await walk("", 0);
  return files;
}

export function checkPinnedTests(before: Array<{ path: string; sha256: string }> | undefined, after: Array<{ path: string; sha256: string }>, context: CollaborationContext, allowDeclaredChanges = false) {
  if (!before) return;
  if (!allowDeclaredChanges && after.some(file => !before.some(old => old.path === file.path))) throw new Error("联合验收前或期间新增了未冻结的测试文件，须重新起草并批准，未运行验证、未发布通过结论。");
  for (const old of before) if (after.find(row => row.path === old.path)?.sha256 !== old.sha256
    && !(allowDeclaredChanges && context.lifecycle?.contract?.testChanges?.some(row => row.participantId === context.participant.id && row.path === old.path))) {
    throw new Error(`测试文件${old.path}的指纹已变化或文件被删除，当前批准方案未授权该测试变化；未运行验证、未发布通过结论。`);
  }
}

export async function fingerprintInformation(turn: AgentTurnResult, root: string) {
  for (const action of turn.actions) {
    if (action.type === "plan.resolve" && action.evidence?.kind === "project_file") {
      delete action.evidence.contentHash;
      const hash = await hashProjectFile(root, action.evidence.path);
      if (hash) action.evidence.contentHash = hash;
    } else if (action.type === "information.respond") {
      for (const source of action.sources) {
        if (source.scope !== "local_project") continue;
        delete source.contentHash;
        const hash = await hashProjectFile(root, source.reference);
        if (hash) source.contentHash = hash;
      }
    }
  }
}

/** Cached facts are reused only after their owning project verifies the actual source bytes. */
export async function verifyCachedFact(context: CollaborationContext, root: string): Promise<AgentTurnResult | null> {
  if (context.informationTask?.mode !== "verify") return null;
  const request = context.lifecycle?.informationRequests.find(row => row.id === context.informationTask!.requestId);
  const fact = context.lifecycle?.facts.find(row => row.key === request?.cachedFactKey);
  const response = fact?.responses.find(row => row.participantId === context.participant.id);
  if (!request || !fact || !response || fact.status === "conflicted") return null;
  const local = response.sources.filter(source => source.scope === "local_project");
  if (!local.length || local.some(source => !source.contentHash)) return null;
  const matches = (await Promise.all(local.map(async source => await hashProjectFile(root, source.reference) === source.contentHash))).every(Boolean);
  return { message: matches ? "Connector已只读核对共享事实的本方资料指纹，复用已知事实；无需再次调用模型。" : "Connector发现缓存事实来源已变化，转入当前资料重新检索。", kind: "status", notifyParticipantIds: [], needsHumanInput: false,
    actions: [{ type: "information.respond", revision: context.lifecycle!.revision, requestId: request.id, attempt: request.attempt ?? 1, status: matches ? "found" : "unavailable", value: fact.value, answer: matches ? fact.answer : "缓存来源的当前文件哈希与已知事实不符，不能继续使用旧值。", sources: response.sources, validForSeconds: Math.max(30, Math.min(86400, response.validForSeconds ?? 3600)) }] };
}
