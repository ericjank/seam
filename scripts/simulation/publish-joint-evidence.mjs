#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SimulationApi } from "./http.mjs";

// Upload an allowlisted, actually recorded joint check. Full local model output,
// source files, project paths, credentials and app-server state stay on this host.
export async function publishJointEvidence({ api, runRoot, collaborationId, revision }) {
  assert.match(collaborationId, /^[a-f0-9-]{36}$/i, "a collaboration UUID is required");
  assert.ok(Number.isInteger(revision) && revision > 0);
  const evidenceFile = join(runRoot, `revision-${revision}-report.json`);
  const raw = await readFile(evidenceFile, "utf8");
  const recorded = JSON.parse(raw);
  const state = recorded.lifecycle;
  const joint = recorded.joint;
  assert.equal(state?.revision, revision, "local report revision mismatch");
  assert.equal(joint?.revision, revision, "joint result revision mismatch");
  assert.equal(joint?.status, "passed", "only a recorded successful joint check can be published as passed");
  assert.equal(joint?.transport, "real localhost HTTP", "a fixture protocol reply is not an actual joint HTTP result");
  assert.ok(Number.isInteger(joint.receivedRequests) && joint.receivedRequests >= (revision >= 2 ? 7 : 4), "joint check must contain its actual request count");
  assert.match(state.documentHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(state.approvedHash, state.documentHash, "the executed plan must have been approved");
  assert.equal(state.reports?.length, 2);
  assert.ok(state.reports.every((report) => report.status === "passed"));
  const approvedDocument = await readFile(join(runRoot, `revision-${revision}-approved-plan.md`), "utf8");
  assert.equal(createHash("sha256").update(approvedDocument).digest("hex"), state.documentHash, "approved document contents must match the recorded hash");

  const before = await api.detail(collaborationId);
  const historical = before.lifecycleHistory?.find((item) => item.revision === revision);
  assert.ok(historical, "the target collaboration must contain this revision");
  assert.equal(historical.documentHash, state.documentHash, "local evidence belongs to a different collaboration or document");
  assert.ok(state.reports.every((report) => before.participants.some((item) => item.participant.id === report.participantId)), "execution receipts must belong to the target collaboration");
  const content = {
    schemaVersion: 1, kind: "simulation.http-joint-check", collaborationId, revision,
    documentHash: state.documentHash, status: joint.status, transport: joint.transport,
    receivedRequests: joint.receivedRequests,
    evidence: { file: basename(evidenceFile), sha256: createHash("sha256").update(raw).digest("hex") },
    scope: "独立模拟运行器在双方实施及测试回执之后，用虚拟提供方实际代码开启本机HTTP服务，由真实Codex编写的消费方代码调用并断言通过。仅覆盖本次隔离合成报价接口；未部署，不代表实际业务系统或生产验收。",
    relationship: "本产物补充双方报告提交之后取得的联合HTTP证据，保留两端原始execution.report及其当时尚未执行联合测试的真实描述。",
  };
  const result = await api.call(`/api/collaborations/${collaborationId}/artifacts`, {
    title: `第${revision}轮 HTTP 联合验证`, type: "test-report", content: JSON.stringify(content, null, 2),
  });
  const after = await api.detail(collaborationId);
  assert.equal(after.lifecycleHistory.find((item) => item.revision === revision).report, historical.report, "publishing joint evidence must not rewrite either endpoint's execution report");
  const receipt = { revision, artifactId: result.artifactId, version: result.version, unchanged: result.unchanged,
    status: joint.status, receivedRequests: joint.receivedRequests, documentHash: state.documentHash };
  await writeFile(join(runRoot, `revision-${revision}-joint-publication.json`), JSON.stringify(receipt, null, 2));
  return receipt;
}

async function main() {
  const flags = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    assert.ok(["--run-root", "--collaboration-id", "--revision", "--wait-ms"].includes(name) && value, "use --run-root PATH --collaboration-id UUID --revision N [--wait-ms 900000]");
    flags.set(name, value);
  }
  assert.ok(flags.has("--run-root"), "--run-root is required");
  const runRoot = resolve(flags.get("--run-root"));
  const collaborationId = flags.get("--collaboration-id");
  const revision = Number(flags.get("--revision"));
  const waitMs = Number(flags.get("--wait-ms") ?? 0);
  assert.ok(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 3_600_000);
  const deadline = Date.now() + waitMs;
  const file = join(runRoot, `revision-${revision}-report.json`);
  let waitingReported = false;
  while (true) {
    try { JSON.parse(await readFile(file, "utf8")); break; }
    catch (error) {
      if (!((error.code === "ENOENT" || error instanceof SyntaxError) && Date.now() < deadline)) throw error;
      if (!waitingReported) { console.log(JSON.stringify({ event: "waiting-for-actual-joint-evidence", revision })); waitingReported = true; }
      await delay(Math.min(1000, Math.max(1, deadline - Date.now())));
    }
  }
  const api = new SimulationApi();
  await api.loginOwner();
  const receipt = await publishJointEvidence({ api, runRoot, collaborationId, revision });
  console.log(JSON.stringify({ ok: true, event: "joint-evidence-published", ...receipt }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
