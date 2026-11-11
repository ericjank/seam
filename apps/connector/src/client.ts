import { connectorJobSchema, type ConnectorJob } from "@seam/protocol";
import type { ConnectorConfig } from "./config.js";

export interface ConnectorCapabilities {
  adapter: ConnectorConfig["adapter"];
  executionMode: "read-only" | "workspace-write" | "external";
  testConfigured: boolean;
}

export class PlatformClient {
  private attempts = new Map<string, number>();
  constructor(private config: ConnectorConfig) {}

  async heartbeat(capabilities?: ConnectorCapabilities) {
    return this.request("/api/connectors/heartbeat", { agentId: this.config.agentId, capabilities });
  }

  async poll(): Promise<ConnectorJob | null> {
    const response = await this.request("/api/connectors/poll", { agentId: this.config.agentId, waitMs: 20000 });
    const job = response.job ? connectorJobSchema.parse(response.job) : null;
    if (job) this.attempts.set(job.id, job.attempts);
    return job;
  }

  async complete(jobId: string, result: Record<string, unknown> | undefined, error?: string) {
    const response = await this.request("/api/connectors/complete", {
      agentId: this.config.agentId, jobId, attempts: this.attempts.get(jobId), status: error ? "failed" : "completed", result, error,
    });
    this.attempts.delete(jobId);
    return response;
  }

  async claimCredential(credentialId: string) {
    const response = await this.request(`/api/connectors/credentials/${credentialId}`, { agentId: this.config.agentId });
    return response.credential as { name: string; type: string; environment: string; value: string };
  }

  private async request(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${this.config.platformUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify(body),
    });
    const data = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(data.error?.message ?? `平台返回 ${response.status}`);
    return data as Record<string, any>;
  }
}
