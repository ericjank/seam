import { describe, expect, it } from "vitest";
import { runLocalTest } from "../src/local-test";

describe("Connector 本地测试", () => {
  it("执行本地配置的测试命令并返回证据", async () => {
    process.env.SEAM_TEST_COMMAND = `${JSON.stringify(process.execPath)} -e "console.log('contract ok')"`;
    const result = await runLocalTest(process.cwd());
    expect(result.status).toBe("passed");
    expect(result.evidence.exitCode).toBe(0);
    expect(result.evidence.outputTail).toContain("contract ok");
  });

  it("测试失败不会伪装为通过", async () => {
    process.env.SEAM_TEST_COMMAND = `${JSON.stringify(process.execPath)} -e "process.exit(2)"`;
    const result = await runLocalTest(process.cwd());
    expect(result.status).toBe("failed");
    expect(result.evidence.exitCode).toBe(2);
  });
});
