import { describe, expect, it } from "vitest";
import { analyzeContractDiff, validateArtifact } from "../src/lib/contract";

describe("接口契约", () => {
  it("校验 OpenAPI 文档", () => {
    expect(() => validateArtifact("openapi", JSON.stringify({ openapi: "3.1.0", paths: {} }))).not.toThrow();
    expect(() => validateArtifact("openapi", "{}")).toThrow();
  });

  it("识别删除路径和模型等破坏性变更", () => {
    const before = { openapi: "3.1.0", paths: { "/orders": {} }, components: { schemas: { Order: {} } } };
    const after = { openapi: "3.1.0", paths: {}, components: { schemas: {} } };
    const warnings = analyzeContractDiff(JSON.stringify(before), JSON.stringify(after));
    expect(warnings).toContain("删除接口路径：/orders");
    expect(warnings).toContain("删除数据模型：Order");
  });
});
