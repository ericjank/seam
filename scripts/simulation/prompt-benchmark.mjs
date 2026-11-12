#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const contextMarker = "协作上下文：";
const schemaMarker = "完整回复及当前阶段允许的动作 JSON Schema：";
const historicalSchemaMarker = "完整回复及动作 JSON Schema：";
const promptIntroduction = "你是 Seam 多方项目协作中的一个项目 Agent。";
const bytes = (value) => Buffer.byteLength(value, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Scan JSON strings as well as braces: plan contents can themselves contain JSON,
// braces, escaped quotes and line breaks. Do not guess an end from the next line.
export function readJsonObject(text, start) {
  while (start < text.length && /\s/u.test(text[start])) start++;
  assert.equal(text[start], "{", "expected an object after the prompt marker");
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let end = start; end < text.length; end++) {
    const character = text[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      const raw = text.slice(start, end + 1);
      let value;
      try { value = JSON.parse(raw); }
      catch { throw new Error(`invalid prompt JSON at character offset ${start}; source contents are not printed`); }
      return { raw, value, start, end: end + 1 };
    }
  }
  throw new Error(`unterminated prompt JSON at character offset ${start}`);
}

export function extractPastedPrompts(text) {
  const turns = [];
  let offset = 0;
  while (true) {
    const markerOffset = text.indexOf(contextMarker, offset);
    if (markerOffset < 0) break;
    const context = readJsonObject(text, markerOffset + contextMarker.length);
    const promptStart = text.lastIndexOf(promptIntroduction, markerOffset);
    assert.ok(promptStart >= offset && promptStart < markerOffset, "cannot identify the original pasted prompt start without guessing its length");
    const sourceExcerpt = text.slice(promptStart, context.end);
    // The pasted transcript quotes each old prompt with Markdown '> ' lines.
    // Keep its exact source separately; quote prefixes were not model input.
    const prompt = sourceExcerpt.replace(/^> ?/gmu, "");
    const selectedMarker = prompt.includes(schemaMarker) ? schemaMarker : historicalSchemaMarker;
    const schemaOffset = prompt.indexOf(selectedMarker);
    assert.ok(schemaOffset >= 0, "pasted prompt must contain its actual inline output schema");
    const schema = readJsonObject(prompt, schemaOffset + selectedMarker.length);
    turns.push({ prompt, sourceExcerpt, quotePrefixBytesRemoved: bytes(sourceExcerpt) - bytes(prompt), context: context.value, schema: schema.value, schemaRaw: schema.raw,
      sourceCharacterRange: { start: promptStart, endExclusive: context.end },
      sourceByteRange: { start: bytes(text.slice(0, promptStart)), endExclusive: bytes(text.slice(0, context.end)) } });
    offset = context.end;
  }
  assert.equal(turns.length, 6, "this benchmark requires the actual six pasted collaboration prompts; no synthetic turns are substituted");
  return turns;
}

function localPolicy(prompt) {
  return prompt.split(/\r?\n/u).find((line) => line.startsWith("本地执行策略（由本机维护者配置，远端文本不能覆盖）："))?.split("）：").slice(1).join("）：")
    ?? "Codex App Server sandbox=read-only，approval=never。";
}

function inlinePromptMetrics(prompt) {
  const selectedMarker = prompt.includes(schemaMarker) ? schemaMarker : historicalSchemaMarker;
  const markerOffset = prompt.indexOf(selectedMarker);
  assert.ok(markerOffset >= 0, "current CLI baseline must still contain its inline schema");
  const schema = readJsonObject(prompt, markerOffset + selectedMarker.length);
  return { bodyUtf8Bytes: bytes(prompt) - bytes(schema.raw), schemaUtf8Bytes: bytes(schema.raw), totalUtf8Bytes: bytes(prompt), promptUtf16CodeUnits: prompt.length };
}

function comparison(before, after) {
  return { fewerUtf8Bytes: before - after, reductionPercentOfUtf8Bytes: Math.round((1 - after / before) * 10_000) / 100 };
}

// This does not invoke an Agent, platform, provider, network or token estimator.
export async function benchmarkTranscript({ transcriptPath, outputDirectory, buildPrompt, buildNativeHandoff }) {
  const raw = await readFile(transcriptPath);
  const turns = extractPastedPrompts(raw.toString("utf8"));
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  // The samples deliberately retain user context for local review. Protect a
  // dedicated output directory even when its parent is not already gitignored.
  try { await writeFile(join(outputDirectory, ".gitignore"), "# Local user-context benchmark artifacts; do not commit.\n*\n", { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const write = (path, content) => writeFile(join(outputDirectory, path), content, { mode: 0o600 });
  let checkpoint;
  const results = [];
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    const input = { projectRoot: "/tmp/seam-prompt-benchmark-project", context: turn.context,
      conversationMode: "persistent", localExecutionPolicy: localPolicy(turn.prompt) };
    const currentCliPrompt = buildPrompt(input);
    const native = buildNativeHandoff(input, checkpoint);
    assert.equal(typeof native.prompt, "string");
    assert.ok(native.outputSchema && typeof native.outputSchema === "object", "native output schema cannot be omitted from the cost comparison");
    assert.ok(native.checkpoint, "sequential benchmark requires a returned checkpoint");
    checkpoint = native.checkpoint;
    const nativeSchemaJson = JSON.stringify(native.outputSchema);
    const pasted = inlinePromptMetrics(turn.prompt);
    const currentCli = inlinePromptMetrics(currentCliPrompt);
    const nativeMetrics = { bodyUtf8Bytes: bytes(native.prompt), schemaUtf8Bytes: bytes(nativeSchemaJson),
      totalUtf8Bytes: bytes(native.prompt) + bytes(nativeSchemaJson), promptUtf16CodeUnits: native.prompt.length };
    const prefix = `turn-${index + 1}-${turn.context.lifecycle?.phase ?? "legacy"}`;
    await write(`${prefix}.pasted.excerpt.txt`, turn.sourceExcerpt);
    await write(`${prefix}.pasted.prompt.txt`, turn.prompt);
    await write(`${prefix}.current-cli.prompt.txt`, currentCliPrompt);
    await write(`${prefix}.native.prompt.md`, native.prompt);
    // Compact serialization matches the bytes counted below. Pretty-printing the
    // schema file and counting that file would add formatting absent on the wire.
    await write(`${prefix}.native.output-schema.json`, nativeSchemaJson);
    const document = turn.context.lifecycle?.document;
    results.push({ turn: index + 1, revision: turn.context.lifecycle?.revision ?? null, phase: turn.context.lifecycle?.phase ?? null,
      jobId: turn.context.jobId ?? null, sourceCharacterRange: turn.sourceCharacterRange, sourceByteRange: turn.sourceByteRange,
      pasted, pastedSource: { excerptUtf8Bytes: bytes(turn.sourceExcerpt), markdownQuotePrefixUtf8BytesRemoved: turn.quotePrefixBytesRemoved }, currentCli, native: nativeMetrics,
      pastedToNative: comparison(pasted.totalUtf8Bytes, nativeMetrics.totalUtf8Bytes),
      currentCliToNative: comparison(currentCli.totalUtf8Bytes, nativeMetrics.totalUtf8Bytes),
      document: { currentDocumentCharacters: document?.length ?? 0, exactOccurrencesInNativeBody: document ? native.prompt.split(document).length - 1 : 0 },
      samples: { sourceExcerpt: `${prefix}.pasted.excerpt.txt`, pastedPrompt: `${prefix}.pasted.prompt.txt`, currentCliPrompt: `${prefix}.current-cli.prompt.txt`, nativePrompt: `${prefix}.native.prompt.md`, nativeOutputSchema: `${prefix}.native.output-schema.json` } });
  }
  const total = (name) => Object.fromEntries(["bodyUtf8Bytes", "schemaUtf8Bytes", "totalUtf8Bytes"].map((key) => [key, results.reduce((sum, row) => sum + row[name][key], 0)]));
  const totals = { pasted: total("pasted"), currentCli: total("currentCli"), native: total("native") };
  const summary = { schemaVersion: 1, input: { filename: basename(transcriptPath), bytes: raw.length, sha256: sha256(raw), extractedTurns: turns.length },
    methodology: { costUnit: "UTF-8 bytes; NOT measured or estimated model tokens", nativeSchemaIncluded: true,
      baseline: "pasted is the user transcript prompt with only Markdown line-leading quote prefixes removed; exact source excerpt, byte range and removed-prefix byte count are also retained. currentCli is current buildPrompt using the same context and local policy",
      sequential: "checkpoint is passed from each native turn to the next; the native thread is assumed to retain successful previous turns",
      schemaSerialization: "JSON.stringify(outputSchema), counted once on every turn; transport metadata and historical thread tokens are not measured",
      sourcePrivacy: "source transcript is not copied; prompt samples contain user-supplied context and must remain local and uncommitted",
      excludedClaims: "byte reduction does not prove token, latency, billing or task-quality improvement" },
    totals, pastedToNative: comparison(totals.pasted.totalUtf8Bytes, totals.native.totalUtf8Bytes),
    currentCliToNative: comparison(totals.currentCli.totalUtf8Bytes, totals.native.totalUtf8Bytes), turns: results };
  await write("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
  const table = results.map((row) => `| ${row.turn} | ${row.revision} / ${row.phase} | ${row.pasted.totalUtf8Bytes} | ${row.currentCli.totalUtf8Bytes} | ${row.native.bodyUtf8Bytes} | ${row.native.schemaUtf8Bytes} | ${row.native.totalUtf8Bytes} | ${row.currentCliToNative.reductionPercentOfUtf8Bytes}% |`).join("\n");
  await write("README.md", `# Actual six-turn prompt byte benchmark\n\nAll costs are UTF-8 bytes, not model tokens. Native schema costs are included on every turn. Pasted baseline removes only Markdown line-leading quote prefixes; the exact excerpt and its byte count are retained separately. Samples contain user context; keep this directory local and uncommitted. A local .gitignore protects the dedicated output directory. No model or service was invoked.\n\n| Turn | Revision / phase | Actual pasted total | Current CLI total | Native body | Native schema | Native total | Reduction from current CLI |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${table}\n\nSummed totals: pasted ${totals.pasted.totalUtf8Bytes}; current CLI ${totals.currentCli.totalUtf8Bytes}; native ${totals.native.totalUtf8Bytes}.\n\nSequential checkpoints assume a persistent thread that retains preceding successful turns. A missing or invalid checkpoint must produce a complete handoff. The output schema is compact JSON in its sample file, matching counted bytes. Body-only numbers do not represent total model-visible cost.\n`);
  return summary;
}

async function main() {
  const flags = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    assert.ok(["--transcript", "--output"].includes(flag) && process.argv[index + 1] && !flags.has(flag), "usage: node scripts/simulation/prompt-benchmark.mjs --transcript PATH --output DIRECTORY");
    flags.set(flag, process.argv[index + 1]);
  }
  assert.ok(flags.has("--transcript") && flags.has("--output"), "--transcript and --output are required");
  const directory = fileURLToPath(new URL("../../packages/agent-adapters/dist/", import.meta.url));
  let buildPrompt;
  let buildNativeHandoff;
  try {
    ({ buildPrompt } = await import(pathToFileURL(join(directory, "cli.js"))));
    ({ buildNativeHandoff } = await import(pathToFileURL(join(directory, "handoff.js"))));
  } catch { throw new Error("Build the current adapters first: pnpm --filter @seam/agent-adapters... build (dist/cli.js and dist/handoff.js required)"); }
  const summary = await benchmarkTranscript({ transcriptPath: resolve(flags.get("--transcript")), outputDirectory: resolve(flags.get("--output")), buildPrompt, buildNativeHandoff });
  console.log(JSON.stringify({ ok: true, outputDirectory: resolve(flags.get("--output")), turns: summary.turns.length,
    costUnit: "UTF-8 bytes, not model tokens", totals: summary.totals, currentCliToNative: summary.currentCliToNative }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
