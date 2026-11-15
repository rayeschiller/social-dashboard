/** Test-only row builders. Every value they insert is SYNTHETIC and passed in by the test. */
import type pg from "pg";

/**
 * Inserts an account row. Unless `pin` is false, the first account inserted also becomes the
 * tracked (pinned) account, as the first successful account sync would make it.
 */
export async function insertAccount(db: pg.Pool, igUserId = "synthetic-ig-1", username = "synthetic_user", pin = true) {
  await db.query("INSERT INTO ig_accounts (ig_user_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING", [igUserId, username]);
  if (pin) {
    await db.query(
      "INSERT INTO tracked_account (ig_user_id, username_at_pin, pinned_via) VALUES ($1, $2, 'account_sync') ON CONFLICT DO NOTHING",
      [igUserId, username],
    );
  }
  return igUserId;
}

export async function insertRun(db: pg.Pool, kind = "account", startedAt = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO sync_runs (kind, trigger, started_at, finished_at, status) VALUES ($1, 'test', $2, $2, 'succeeded') RETURNING id`,
    [kind, startedAt],
  );
  return rows[0]!.id;
}

/**
 * Insert one followers_count snapshot (status 'available' unless value is null). created_at is
 * set to retrievedAt so fixtures dated after the real clock behave as if inserted at that time.
 */
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
       media_count_status, source, retrieved_at, sync_run_id, status_reason, created_at)
     VALUES ($1, $2, $3, 'unavailable', 'unavailable', 'instagram_graph_api', $4, $5, $6, $4) RETURNING id`,
    [igUserId, followers, status, at, runId, followers === null ? "synthetic missing value" : null],
  );
  return rows[0]!.id;
}
