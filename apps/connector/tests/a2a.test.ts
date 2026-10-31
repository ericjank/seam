import { describe, expect, it } from "vitest";
import { MockAgentAdapter } from "@seam/agent-adapters";
import { createA2AHandler, readConfig } from "../src/index";

describe("Connector A2A", () => {
  it("通过官方 SDK 处理 message/send", async () => {
    const { transport } = createA2AHandler(new MockAgentAdapter(), process.cwd(), "test-agent", "http://localhost/a2a");
    const response = await transport.handle({
      jsonrpc: "2.0", id: 1, method: "message/send",
      params: { message: { kind: "message", messageId: crypto.randomUUID(), role: "user", parts: [{ kind: "text", text: "你好" }] } },
    });
    expect(Symbol.asyncIterator in Object(response)).toBe(false);
    const result = (response as { result: { parts: Array<{ kind: string; text?: string }> } }).result;
    expect(result.parts[0]?.text).toContain("Mock Agent");
  });

  it("解析最小 Connector 配置", () => {
    const config = readConfig([], {
      SEAM_AGENT_ID: crypto.randomUUID(), SEAM_AGENT_TOKEN: "token", SEAM_PROJECT_ROOT: ".",
    });
    expect(config.adapter).toBe("mock");
    expect(config.platformUrl).toBe("http://localhost:3000");
  });
});
