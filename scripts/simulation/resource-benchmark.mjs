#!/usr/bin/env node
// Deterministic replay of identical historical job contexts; no model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";
import { buildNativeHandoff, materializeHandoffResources } from "../../packages/agent-adapters/dist/handoff.js";
import { collaborationContextSchema } from "../../packages/protocol/dist/index.js";

const [sourcePath, outputPath, baselineCommit] = process.argv.slice(2);
assert.ok(sourcePath && outputPath && /^[a-f0-9]{40}$/.test(baselineCommit ?? ""), "database JSON, output directory and exact baseline commit required");
const output = resolve(outputPath); await mkdir(output, { recursive: true, mode: 0o700 });
const protocol = pathToFileURL(join(output, "legacy-protocol.mjs")).href;
const adapterRequire = createRequire(pathToFileURL(resolve("packages/agent-adapters/package.json")));
const zod = pathToFileURL(adapterRequire.resolve("zod").replace(/\.cjs$/, ".js")).href;
for (const [source, target] of [["packages/protocol/src/index.ts", "legacy-protocol.mjs"], ["packages/agent-adapters/src/handoff.ts", "legacy-handoff.mjs"], ["packages/agent-adapters/src/response-schema.ts", "legacy-schema.mjs"]]) {
  const text = execFileSync("git", ["show", `${baselineCommit}:${source}`], { encoding: "utf8" });
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replaceAll('"@seam/protocol"', JSON.stringify(protocol)).replaceAll('"zod"', JSON.stringify(zod)).replaceAll('"./response-schema.js"', '"./legacy-schema.mjs"');
  await writeFile(join(output, target), compiled, { mode: 0o600 });
}
const { buildNativeHandoff: legacy, materializeHandoffResources: materializeLegacy } = await import(pathToFileURL(join(output, "legacy-handoff.mjs")));
const db = JSON.parse(await readFile(sourcePath, "utf8"));
const rows = db.tables.connector_jobs.filter((job) => job.payload?.context && job.result?.conversation?.threadId).sort((a,b) => a.sequence-b.sequence);
assert.ok(rows.length, "actual native job contexts required");
let previous, before; const results = [];
for (const job of rows) {
  const input = { projectRoot: "/private/isolated-benchmark", context: collaborationContextSchema.parse(job.payload.context), conversationMode: "persistent", localExecutionPolicy: "遵守本机配置和当前批准阶段" };
  const legacyInput = materializeLegacy ? await materializeLegacy(input, join(output, "before-resources")) : input;
  const old = legacy(legacyInput, before); before = old.checkpoint;
  const prepared = await materializeHandoffResources(input, join(output, "after-resources"), undefined, false);
  const next = buildNativeHandoff(prepared, previous); previous = next.checkpoint;
  const metric = (value) => ({ chars: value.prompt.length, bodyBytes: Buffer.byteLength(value.prompt), schemaBytes: Buffer.byteLength(JSON.stringify(value.outputSchema)) });
  await writeFile(join(output, `${job.sequence}-handoff.md`), next.prompt, { mode: 0o600 });
  results.push({ sequence: job.sequence, revision: input.context.lifecycle.revision, phase: input.context.lifecycle.phase, before: metric(old), after: metric(next), resourceBytesAvailableOnDemand: prepared.resources.reduce((sum,item) => sum+item.bytes,0) });
}
const summary = { baselineCommit, method: "Same actual historical job contexts replayed sequentially through the pinned baseline (including its own protocol/schema and resource materialization) and current native implementation. UTF-8 bytes and JS string lengths, not tokens. Schema cost included separately. On-demand file reads and retained conversation history are not measured; no claim of equal token, time or billing reduction.", results };
await writeFile(join(output, "summary.json"), JSON.stringify(summary,null,2));
console.log(JSON.stringify({ turns: results.length, beforeBodyBytes: results.reduce((s,r)=>s+r.before.bodyBytes,0), afterBodyBytes: results.reduce((s,r)=>s+r.after.bodyBytes,0), maxBeforeChars:Math.max(...results.map(r=>r.before.chars)), maxAfterChars:Math.max(...results.map(r=>r.after.chars)) }));
