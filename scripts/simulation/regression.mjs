#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

// Run inside the isolated simulation app container. The existing workflow suite
// intentionally requires a loopback DB target; preserve that guard by exposing
// the container's synthetic MySQL on a temporary loopback-only TCP endpoint.
assert.equal(process.env.DB_HOST, "mysql", "run only inside the simulation app container");
assert.equal(process.env.DB_DATABASE, "seam_simulation_test", "only the synthetic simulation database is allowed");
const sockets = new Set();
const proxy = createServer((client) => {
  const upstream = createConnection({ host: "mysql", port: Number(process.env.DB_PORT ?? 3306) });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => { client.destroy(); upstream.destroy(); });
  }
  client.pipe(upstream).pipe(client);
});
await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(0, "127.0.0.1", resolve);
});
const address = proxy.address();
assert.ok(address && typeof address === "object");
const env = {
  ...process.env, DB_HOST: "127.0.0.1", DB_PORT: String(address.port),
  SEAM_APP_URL: "http://127.0.0.1:3000",
  SEAM_TEST_OWNER_EMAIL: process.env.SEAM_TEST_OWNER_EMAIL ?? "simulation-owner@seam.test",
  SEAM_TEST_OWNER_PASSWORD: process.env.SEAM_TEST_OWNER_PASSWORD ?? "LocalSimulation!2026",
};
try {
  for (const file of ["tests/integration.ts", "tests/workflow-integration.ts"]) {
    console.log(JSON.stringify({ event: "regression-start", file, database: env.DB_DATABASE }));
    await new Promise((resolve, reject) => {
      const child = spawn("pnpm", ["--filter", "@seam/platform", "exec", "tsx", file], { env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${file} exited with ${signal ?? code}`)));
    });
    console.log(JSON.stringify({ event: "regression-passed", file }));
  }
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
}
