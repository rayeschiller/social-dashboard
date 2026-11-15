import path from "node:path";
import { config } from "dotenv";
import { createPool } from "../../src/lib/db";
import { runMigrations } from "../../src/lib/db/migrate";
import { testDatabaseUrl } from "./test-db";

export default async function setup() {
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
  const pool = createPool(testDatabaseUrl());
  try {
    await runMigrations(pool, path.resolve("migrations"));
  } finally {
    await pool.end();
  }
}
