/**
 * npm run migrate              -> migrates DATABASE_URL
 * npm run migrate -- --test    -> migrates TEST_DATABASE_URL
 */
import path from "node:path";
import { createPool } from "../src/lib/db";
import { runMigrations } from "../src/lib/db/migrate";
import { loadEnv } from "./load-env";

loadEnv();

async function main() {
  const useTest = process.argv.includes("--test");
  const url = useTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${useTest ? "TEST_DATABASE_URL" : "DATABASE_URL"} is not set (see .env.example)`);
  const pool = createPool(url);
  try {
    const res = await runMigrations(pool, path.resolve("migrations"));
    console.info(
      `migrations (${useTest ? "test" : "dev"} db): applied ${res.applied.length} [${res.applied.join(", ")}], already applied ${res.alreadyApplied.length}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
