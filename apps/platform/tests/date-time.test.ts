import { expect, it } from "vitest";
import { formatDateTime } from "../src/lib/date-time";

it("Docker UTC 与不同时区的浏览器在跨日时刻生成相同时间文字", () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
      process.env.TZ = timezone;
      expect(formatDateTime("2026-11-11T16:00:01.000Z")).toBe("2026-11-12 00:00:01");
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
