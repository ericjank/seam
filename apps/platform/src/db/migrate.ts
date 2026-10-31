import { migrate } from "drizzle-orm/mysql2/migrator";
import { db, pool } from "./index";

async function main() {
  await pool.query("SELECT 1");
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  console.log("MySQL migrations applied");
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
