import { randomUUID } from "node:crypto";
import { readinessPool as pool } from "@/db";

let cached: { at: number; ok: boolean } | undefined;
let pending: Promise<boolean> | undefined;
/** Commit to one dedicated operational row; a rollback would miss binlog failures. */
export async function databaseWritable() {
  if (cached && Date.now() - cached.at < 3000) return cached.ok;
  if (pending) return pending;
  pending = (async () => {
    let connection: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
    try {
      connection = await pool.getConnection();
      const nonce = randomUUID();
      await connection.query({ sql: "INSERT INTO readiness_probes(id,nonce,checked_at) VALUES('database-write',?,NOW(3)) ON DUPLICATE KEY UPDATE nonce=?,checked_at=NOW(3)", values: [nonce, nonce], timeout: 1500 });
      cached = { at: Date.now(), ok: true }; return true;
    } catch {
      // A timed-out write must not keep occupying a pooled connection.
      connection?.destroy(); connection = undefined;
      cached = { at: Date.now(), ok: false }; return false;
    } finally { connection?.release(); }
  })().finally(() => { pending = undefined; });
  return pending;
}
