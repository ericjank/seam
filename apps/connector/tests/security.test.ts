import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialStore } from "../src/credential-store";
import { assertOutboundPolicy } from "../src/outbound-policy";

describe("Connector 本地安全", () => {
  it("以私有权限保存联调凭据", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seam-store-"));
    const agentId = crypto.randomUUID();
    try {
      const store = new CredentialStore(agentId, directory);
      await store.put("test", "token-value");
      expect(await store.get("test")).toBe("token-value");
      const mode = (await stat(join(directory, `${agentId}.json`))).mode & 0o777;
      expect(mode).toBe(0o600);
      const content = await readFile(join(directory, `${agentId}.json`), "utf8");
      expect(content).toContain("token-value");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("阻止系统密钥和源码路径进入普通消息", () => {
    expect(() => assertOutboundPolicy({ message: "DATABASE_URL=mysql://user:pass@host/db", kind: "chat", actions: [], notifyParticipantIds: [], needsHumanInput: false }, "/private")).toThrow();
    expect(assertOutboundPolicy({ message: "请通过凭据流程申请测试 Token", kind: "chat", actions: [], notifyParticipantIds: [], needsHumanInput: false }, "/private").message).toContain("凭据流程");
  });
});
