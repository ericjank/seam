import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { AsyncLocalStorage } from "node:async_hooks";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  seamPool?: mysql.Pool;
};

export const pool = globalForDb.seamPool ?? mysql.createPool({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE ?? "seam",
  connectionLimit: 10,
  charset: process.env.DB_CHARSET ?? "utf8mb4",
  waitForConnections: true,
  enableKeepAlive: true,
  timezone: "Z",
});

pool.on("connection", (connection) => {
  void connection.query("SET time_zone = '+00:00'");
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.seamPool = pool;
}

const database = drizzle(pool, { schema, mode: "default" });
export type Transaction = Parameters<Parameters<typeof database.transaction>[0]>[0];
const transactionScope = new AsyncLocalStorage<Transaction>();

// Services share this facade so their writes participate in the caller's
// transaction, including audit messages and any nested service calls.
export const db = new Proxy(database, {
  get(target, property) {
    const active = transactionScope.getStore() ?? target;
    const value = Reflect.get(active, property);
    return typeof value === "function" ? value.bind(active) : value;
  },
});

export async function withTransaction<T>(
  run: (tx: Transaction) => Promise<T>,
  options: { savepoint?: boolean } = {},
): Promise<T> {
  const active = transactionScope.getStore();
  if (active && !options.savepoint) return run(active);
  return (active ?? database).transaction((tx) => transactionScope.run(tx, () => run(tx)));
}
export { schema };
