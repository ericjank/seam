import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { jointFixture } from "./joint-fixture.mjs";
import { providerServerSource } from "./provider-server.mjs";

const exec = promisify(execFile);
for (const scenario of [
  { name: "revision 1 full HTTP contract", revision: 1, passed: true },
  { name: "revision 2 full HTTP contract", revision: 2, passed: true },
  { name: "wrong SKU-002 amount is detected", revision: 1, wrongSku: true, passed: false },
  { name: "client ignoring HTTP errors is detected", revision: 1, ignoreError: true, passed: false },
  { name: "revision 2 missing discount fields is detected", revision: 2, missingDiscount: true, passed: false },
  { name: "unready service stops before quote requests", revision: 1, ready: false, passed: false },
  { name: "old service revision stops before quote requests", revision: 2, healthRevision: 1, passed: false },
]) test(scenario.name, async () => {
  const root = await mkdtemp(join(tmpdir(), "seam-joint-oracle-"));
  let received = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") { response.end(JSON.stringify({ ready: scenario.ready ?? true, revision: scenario.healthRevision ?? scenario.revision })); return; }
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/quote");
      let raw = ""; for await (const chunk of request) raw += chunk;
      received++;
      const input = JSON.parse(raw);
      const prices = { "SKU-001": 12000, "SKU-002": scenario.wrongSku ? 4400 : 4500 };
      if (!Object.hasOwn(prices, input.sku) || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100) throw new Error("invalid input");
      const subtotal = prices[input.sku] * input.quantity;
      const result = { sku: input.sku, quantity: input.quantity, subtotal, currency: "CNY" };
      if (scenario.revision === 2 && !scenario.missingDiscount) {
        const percent = input.discountPercent === undefined ? 0 : input.discountPercent;
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error("invalid discount");
        result.discount = Math.floor(subtotal * percent / 100); result.total = subtotal - result.discount;
      }
      response.end(JSON.stringify(result));
    } catch { response.statusCode = 400; response.end(JSON.stringify({ error: "invalid request" })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(join(root, "client.mjs"), `export async function getQuote(base,input) { const response = await fetch(base + "/quote",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)}); ${scenario.ignoreError ? "" : 'if (!response.ok) throw new Error("HTTP " + response.status);'} return response.json(); }`);
    await writeFile(join(root, "joint.test.mjs"), jointFixture({ liveURL: `http://127.0.0.1:${server.address().port}`, role: "consumer", revision: scenario.revision }));
    let succeeded = true, output;
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    try { output = await exec(process.execPath, ["--test", "joint.test.mjs"], { cwd: root, timeout: 15000, env: childEnvironment }); }
    catch (error) { succeeded = false; output = error; }
    assert.equal(succeeded, scenario.passed, output.stdout);
    if (scenario.ready === false || scenario.healthRevision) assert.equal(received, 0, "unready/old services must not receive quote requests");
    else assert.ok(received >= 4, "the oracle must call the actual peer over HTTP");
    if (scenario.passed) assert.match(output.stdout, new RegExp(`# pass ${scenario.revision === 1 ? 10 : 14}\\b`));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("virtual provider returns 400 before headers and survives consecutive bad requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "seam-provider-http-"));
  await writeFile(join(root, "server.mjs"), providerServerSource(2, 0));
  await writeFile(join(root, "service.mjs"), 'export function quote(input) { if(!input || input.sku!=="SKU-001" || !Number.isInteger(input.quantity) || input.quantity<1 || input.quantity>100)throw new Error("invalid input");return {sku:input.sku,quantity:input.quantity,subtotal:12000*input.quantity,currency:"CNY"}; }');
  const child = spawn(process.execPath, ["server.mjs", join(root, "address.json")], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = ""; child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  try {
    let address;
    const deadline = Date.now() + 5000;
    while (!address && Date.now() < deadline) {
      try { address = JSON.parse(await readFile(join(root, "address.json"), "utf8")); }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      assert.equal(child.exitCode, null, diagnostics);
    }
    assert.ok(address, "actual provider server did not start");
    for (const body of ['{"sku":"SKU-001","quantity":0}', '{"sku":"unknown","quantity":1}', "{", "null", "[]", "false", "42", "{}"]) {
      const response = await fetch(address.baseUrl + "/quote", { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.equal(response.status, 400); assert.match((await response.json()).error, /.+/);
      assert.equal(child.exitCode, null, diagnostics);
    }
    const health = await fetch(address.baseUrl + "/health");
    assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ready: true, revision: 2 });
    const valid = await fetch(address.baseUrl + "/quote", { method: "POST", headers: { "content-type": "application/json" }, body: '{"sku":"SKU-001","quantity":2}' });
    assert.equal(valid.status, 200); assert.equal((await valid.json()).subtotal, 24000);
    assert.equal(diagnostics, "");
  } finally {
    const closed = child.exitCode !== null || child.signalCode ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM"); await closed;
    await rm(root, { recursive: true, force: true });
  }
});
