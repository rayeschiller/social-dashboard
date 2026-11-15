import pg from "pg";
import { createPool } from "../../src/lib/db";

/**
 * The test database. Tests TRUNCATE every table, so refuse anything that does not look like a
 * dedicated test database.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example and README)");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) throw new Error(`refusing to run tests against "${dbName}": name must contain "test"`);
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");
  }
  return url;
}

let pool: pg.Pool | undefined;
export function testPool(): pg.Pool {
  pool ??= createPool(testDatabaseUrl());
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Empties every data table (TRUNCATE bypasses the append-only row triggers). */
export async function resetDb(db: pg.Pool = testPool()): Promise<void> {
  await db.query(`TRUNCATE audit_log, api_errors, media_metric_observations, media,
    account_insight_observations, account_snapshots, oauth_tokens, sync_runs, ig_accounts
    RESTART IDENTITY CASCADE`);
}
