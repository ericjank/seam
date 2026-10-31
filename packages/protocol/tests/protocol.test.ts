import { describe, expect, it } from "vitest";
import { agentTurnResultSchema, contentHash } from "../src/index";

describe("协作协议", () => {
  it("校验结构化 Agent 返回并填充默认值", () => {
    const result = agentTurnResultSchema.parse({ message: "确认契约" });
    expect(result.kind).toBe("chat");
    expect(result.actions).toEqual([]);
    expect(result.needsHumanInput).toBe(false);
  });

  it("拒绝未知动作", () => {
    expect(() => agentTurnResultSchema.parse({ message: "x", actions: [{ type: "source.upload" }] })).toThrow();
  });

  it("生成稳定内容哈希", async () => {
    expect(await contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
