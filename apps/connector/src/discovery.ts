import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** A bounded, read-only inventory. File contents stay local and are read by the Agent as needed. */
export async function discoverProject(projectRoot: string) {
  const files: string[] = [], testCommands: string[] = [];
  const excluded = new Set(["node_modules", "vendor", "dist", "build", "coverage", "storage", "output"]);
  const walk = async (relative: string, depth: number) => {
    let entries;
    try { entries = await readdir(join(projectRoot, relative), { withFileTypes: true }); }
    catch (error) { if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
    for (const entry of entries.sort((a, b) => Number(b.isFile()) - Number(a.isFile()) || a.name.localeCompare(b.name))) {
      if (files.length >= 100) return;
      if (entry.name.startsWith(".") || excluded.has(entry.name) || /(?:\.pem|\.key|credentials|id_rsa|id_ed25519)/i.test(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isFile()) files.push(path);
      else if (entry.isDirectory() && depth < 2) await walk(path, depth + 1);
    }
  };
  await walk("", 0);
  try {
    const manifest = join(projectRoot, "package.json"), info = await lstat(manifest);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 65_536) {
      const content = await readFile(manifest);
      const manifestData = JSON.parse(content.toString("utf8"));
      const scripts = manifestData && typeof manifestData === "object" ? manifestData.scripts : null;
      if (scripts && typeof scripts === "object") for (const [name, command] of Object.entries(scripts)) {
        if (testCommands.length === 20) break;
        if (/test|check|lint/.test(name) && typeof command === "string") testCommands.push(`${name}: ${command}`);
      }
    }
  } catch (error) { if (!["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") && !(error instanceof SyntaxError)) throw error; }
  return { files, testCommands };
}
