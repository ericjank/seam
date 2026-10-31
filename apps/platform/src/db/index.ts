import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
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

export const db = drizzle(pool, { schema, mode: "default" });
export { schema };
