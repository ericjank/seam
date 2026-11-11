import { describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => {
  const nested = { select: () => "savepoint" };
  const transaction = { select: () => "transaction", transaction: vi.fn(async (run) => run(nested)) };
  const database = { select: () => "database", transaction: vi.fn(async (run) => run(transaction)) };
  return { database, transaction, nested };
});
vi.mock("drizzle-orm/mysql2", () => ({ drizzle: () => stores.database }));
vi.mock("mysql2/promise", () => ({ default: { createPool: () => ({ on: () => {} }) } }));

import { db, withTransaction } from "../src/db";

describe("服务事务范围", () => {
  it("全局服务 facade 在事务内复用同一连接，嵌套调用不另开事务", async () => {
    expect(db.select()).toBe("database");
    await withTransaction(async () => {
      expect(db.select()).toBe("transaction");
      await withTransaction(async () => { expect(db.select()).toBe("transaction"); });
      expect(stores.database.transaction).toHaveBeenCalledOnce();
      expect(stores.transaction.transaction).not.toHaveBeenCalled();
    });
    expect(db.select()).toBe("database");
  });

  it("动作 savepoint 有独立范围，异常后恢复外层事务上下文", async () => {
    await withTransaction(async () => {
      await expect(withTransaction(async () => {
        expect(db.select()).toBe("savepoint");
        throw new Error("invalid action");
      }, { savepoint: true })).rejects.toThrow("invalid action");
      expect(db.select()).toBe("transaction");
    });
    expect(db.select()).toBe("database");
  });

  it("异步并发读取不会把事务连接泄漏给其他请求", async () => {
    let entered!: () => void;
    let leave!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const release = new Promise<void>((resolve) => { leave = resolve; });
    const running = withTransaction(async () => {
      entered();
      await release;
      expect(db.select()).toBe("transaction");
    });
    await ready;
    expect(db.select()).toBe("database");
    leave();
    await running;
  });
});
