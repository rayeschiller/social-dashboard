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

const PROTECTED_TABLES = [
  "account_snapshots",
  "account_insight_observations",
  "media_metric_observations",
  "audit_log",
  "tracked_account",
] as const;

/**
 * Empties every data table. TEST-ONLY privileged path: the append-only tables reject TRUNCATE
 * through statement triggers, so this temporarily disables the user triggers inside one
 * transaction. ALTER TABLE ... DISABLE TRIGGER needs table ownership, which only the
 * migration-owner role has; the production app role (scripts/grant-app-role.sql) cannot do it,
 * and no file under src/ contains this code path.
 */
export async function resetDb(db: pg.Pool = testPool()): Promise<void> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ name: string }>("SELECT current_database() AS name");
    if (!/test/i.test(rows[0]?.name ?? "")) throw new Error(`refusing to reset non-test database ${rows[0]?.name}`);
    await client.query("BEGIN");
    for (const t of PROTECTED_TABLES) await client.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    await client.query(`TRUNCATE audit_log, api_errors, media_metric_observations, media,
      account_insight_observations, account_snapshots, oauth_tokens, sync_runs, ig_accounts,
      tracked_account RESTART IDENTITY CASCADE`);
    for (const t of PROTECTED_TABLES) await client.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
