import { relative } from "node:path";
import { realpathSync } from "node:fs";

/** Command attribution, not syscall tracing: count explicit resource reads using either path spelling. */
export function readsHandoffResource(command: string, projectRoot: string, resourceRoot: string) {
  const readable = command.replace(/\\(["' ])/g, "$1");
  if (!/\b(?:cat|head|tail|sed|readFile|read_bytes|read_text|open)\b/.test(readable)) return false;
  const roots = new Set([resourceRoot]), projects = new Set([projectRoot]);
  // macOS exposes /var and /private/var for the same temporary directories.
  // Codex canonicalizes cwd while Connector configuration can use the alias.
  try { roots.add(realpathSync(resourceRoot)); } catch { /* attribution remains best effort */ }
  try { projects.add(realpathSync(projectRoot)); } catch { /* deleted historical paths */ }
  const paths = new Set(roots);
  for (const root of roots) for (const project of projects) { const local = relative(project, root); paths.add(local); paths.add(`./${local}`); }
  return [...paths].filter(Boolean).some(path => readable.includes(path));
}
