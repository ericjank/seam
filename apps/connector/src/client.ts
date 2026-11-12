import { connectorJobSchema, type ConnectorJob } from "@seam/protocol";
import type { ConnectorConfig } from "./config.js";

export interface ConnectorCapabilities {
  adapter: ConnectorConfig["adapter"];
  executionMode: "read-only" | "workspace-write" | "external";
  testConfigured: boolean;
}

export class PlatformError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
  get retryable() { return this.status === 408 || this.status === 429 || this.status >= 500; }
}

export class PlatformClient {
  private attempts = new Map<string, number>();
  constructor(private config: ConnectorConfig) {}

  async heartbeat(capabilities?: ConnectorCapabilities, signal = AbortSignal.timeout(15_000), activeJob?: { id: string; attempts: number; cancelled?: boolean }) {
    return this.request("/api/connectors/heartbeat", { agentId: this.config.agentId, capabilities, activeJob }, signal);
  }

  async poll(): Promise<ConnectorJob | null> {
    const response = await this.request("/api/connectors/poll", { agentId: this.config.agentId, waitMs: 20000 });
    const job = response.job ? connectorJobSchema.parse(response.job) : null;
    if (job) this.attempts.set(job.id, job.attempts);
    return job;
  }

  async complete(jobId: string, result: Record<string, unknown> | undefined, error?: string, attempts = this.attempts.get(jobId)) {
    const response = await this.request("/api/connectors/complete", {
      agentId: this.config.agentId, jobId, attempts, status: error ? "failed" : "completed", result, error,
    }, AbortSignal.timeout(30_000));
    this.attempts.delete(jobId);
    return response;
  }

  async claimCredential(credentialId: string) {
    const response = await this.request(`/api/connectors/credentials/${credentialId}`, { agentId: this.config.agentId });
    return response.credential as { name: string; type: string; environment: string; value: string };
  }

  private async request(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetch(`${this.config.platformUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify(body),
      signal,
    });
    const data = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new PlatformError(response.status, data.error?.message ?? `平台返回 ${response.status}`);
    return data as Record<string, any>;
  }
}
