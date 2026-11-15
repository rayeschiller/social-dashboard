/** Test-only row builders. Every value they insert is SYNTHETIC and passed in by the test. */
import type pg from "pg";

export async function insertAccount(db: pg.Pool, igUserId = "synthetic-ig-1", username = "synthetic_user") {
  await db.query("INSERT INTO ig_accounts (ig_user_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING", [igUserId, username]);
  return igUserId;
}

export async function insertRun(db: pg.Pool, kind = "account", startedAt = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO sync_runs (kind, trigger, started_at, finished_at, status) VALUES ($1, 'test', $2, $2, 'succeeded') RETURNING id`,
    [kind, startedAt],
  );
  return rows[0]!.id;
}

/** Insert one followers_count snapshot (status 'available' unless value is null). */
export async function insertSnapshot(
  db: pg.Pool,
  igUserId: string,
  retrievedAt: string | Date,
  followers: number | null,
  status: string = followers === null ? "unavailable" : "available",
): Promise<number> {
  const at = new Date(retrievedAt);
  const runId = await insertRun(db, "account", at);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO account_snapshots (ig_user_id, followers_count, followers_count_status, follows_count_status,
       media_count_status, source, retrieved_at, sync_run_id, status_reason)
     VALUES ($1, $2, $3, 'unavailable', 'unavailable', 'instagram_graph_api', $4, $5, $6) RETURNING id`,
    [igUserId, followers, status, at, runId, followers === null ? "synthetic missing value" : null],
  );
  return rows[0]!.id;
}
