import assert from "node:assert/strict";

export class SimulationApi {
  cookie = "";

  constructor(base = process.env.SEAM_SIMULATION_URL ?? "http://127.0.0.1:13079") {
    const url = new URL(base);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Simulation API must point to a local installation");
    this.base = base.replace(/\/$/, "");
  }

  async raw(path, body, { token, method = "POST" } = {}) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const session = response.headers.get("set-cookie");
    if (session?.startsWith("seam_session=")) this.cookie = session.split(";")[0];
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`${method} ${path}: HTTP ${response.status}, non-JSON response`); }
    return { response, data };
  }

  async call(path, body, options) {
    const result = await this.raw(path, body, options);
    assert.ok(result.response.ok, `${path}: HTTP ${result.response.status}: ${JSON.stringify(result.data)}`);
    return result.data;
  }

  async expect(path, body, status, options) {
    const result = await this.raw(path, body, options);
    assert.equal(result.response.status, status, `${path}: ${JSON.stringify(result.data)}`);
    return result.data;
  }

  async loginOwner() {
    const email = process.env.SEAM_SIMULATION_EMAIL ?? "simulation-owner@seam.test";
    const password = process.env.SEAM_SIMULATION_PASSWORD ?? "LocalSimulation!2026";
    const setup = await this.raw("/api/setup", { name: "本地模拟管理员", email, password, organizationName: "Seam 本地完整模拟" });
    assert.ok(setup.response.ok || setup.response.status === 409, `setup failed: ${JSON.stringify(setup.data)}`);
    await this.call("/api/auth/login", { email, password });
    return { email, password };
  }

  detail(id) {
    return this.call(`/api/collaborations/${id}`, undefined, { method: "GET" });
  }

  lifecycle(id, body) {
    return this.call(`/api/collaborations/${id}/lifecycle`, body);
  }

  async register(name, adapter) {
    const { project } = await this.call("/api/projects", { name, description: "仅为本次本地模拟创建的独立合成项目" });
    const { agent } = await this.call("/api/agents", { projectId: project.id, name: `${name}-agent`, adapter });
    return { project, agent };
  }
}
