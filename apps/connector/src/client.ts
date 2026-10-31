import { connectorJobSchema, type ConnectorJob } from "@seam/protocol";
import type { ConnectorConfig } from "./config";

export class PlatformClient {
  constructor(private config: ConnectorConfig) {}

  async heartbeat() {
    return this.request("/api/connectors/heartbeat", { agentId: this.config.agentId });
  }

  async poll(): Promise<ConnectorJob | null> {
    const response = await this.request("/api/connectors/poll", { agentId: this.config.agentId, waitMs: 20000 });
    return response.job ? connectorJobSchema.parse(response.job) : null;
  }

  async complete(jobId: string, result: Record<string, unknown> | undefined, error?: string) {
    return this.request("/api/connectors/complete", {
      agentId: this.config.agentId, jobId, status: error ? "failed" : "completed", result, error,
    });
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
