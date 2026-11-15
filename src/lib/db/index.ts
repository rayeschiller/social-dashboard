import pg from "pg";

/** Anything that can run a query: a Pool or a checked-out PoolClient. */
export type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

// BIGINT (int8) and NUMERIC come back from pg as strings by default. Parse them into JS numbers
// so callers never mistake "0" for a truthy string. Values above 2^53 are rejected loudly rather
// than silently rounded (follower counts are nowhere near that).
function parseSafeNumber(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) {
    throw new Error(`numeric value out of safe range: ${text}`);
  }
  return n;
}
pg.types.setTypeParser(pg.types.builtins.INT8, parseSafeNumber);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, parseSafeNumber);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = createPool(connectionString);
  }
  return pool;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
  });
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

export async function withTransaction<T>(
  db: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
