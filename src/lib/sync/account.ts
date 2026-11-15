/**
 * Account-level sync.
 *
 * syncAccount: GET /me?fields=user_id,...,followers_count -> one append-only row in
 *   account_snapshots. followers_count is the ONLY source of the account follower count. If the
 *   API call fails, nothing is written to account_snapshots (the failure lives in sync_runs and
 *   api_errors); there is no fallback, carry-forward or estimate.
 *
 * syncAccountInsights: GET /<IG_ID>/insights?metric=follower_count&period=day over the last 30
 *   days. follower_count is NEW followers per day (Meta keeps 30 days), not a net count; it is
 *   stored as its own metric and never used in net-growth maths. Re-running is idempotent: a day
 *   is appended only when its value/status differs from the latest stored observation for it.
 *
 *   NOTE (2026-11-15): the current User Insights reference page no longer lists follower_count in
 *   its metrics table; it only mentions it under Limitations ("not available on accounts with
 *   fewer than 100 followers"). If Meta rejects the metric the run fails with the API's error and
 *   nothing is stored. https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/
 */
import {
  AccountMismatchError,
  assertTrackable,
  auditRefusal,
  getPinnedAccountId,
  meAccountId,
  pinOrVerify,
  verifyClientAccount,
} from "../account/tracked";
import type { Queryable } from "../db";
import { withTransaction } from "../db";
import { validateMetricValue } from "../instagram/metrics";
import { SOURCES, type AvailabilityStatus } from "../provenance";
import { nowFn, runJob, SyncAbort, type SyncContext, type SyncRunResult } from "./runs";

export const ME_FIELDS = [
  "user_id",
  "id",
  "username",
  "account_type",
  "followers_count",
  "follows_count",
  "media_count",
] as const;

interface CountReading {
  value: number | null;
  status: AvailabilityStatus;
  reason?: string;
}

/** Accept only a non-negative safe integer from the API. Anything else is not a count. */
export function readCount(raw: unknown, field: string): CountReading {
  if (raw === undefined || raw === null) {
    return { value: null, status: "unavailable", reason: `${field} was not returned by the API` };
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return { value: raw, status: "available" };
  }
  if (typeof raw === "number") {
    return { value: null, status: "error", reason: `${field} was ${raw}, not a non-negative whole number within the safe integer range` };
  }
  return { value: null, status: "error", reason: `${field} had an unexpected value type (${typeof raw})` };
}

export async function syncAccount(ctx: SyncContext): Promise<SyncRunResult> {
  const now = nowFn(ctx);
  return runJob(ctx, "account", async (runId, client) => {
    const me = await client.getMe(ME_FIELDS);
    const retrievedAt = now();
    const igUserId = meAccountId(me);
    if (!igUserId) {
      throw new SyncAbort("invalid_response", "GET /me returned neither user_id nor id");
    }
    if (!me.username) throw new SyncAbort("invalid_response", "GET /me returned no username");
    const who = { igUserId, username: me.username };
    const expect = { expectedUsername: ctx.expectedUsername, expectedUserId: ctx.expectedUserId };

    const followers = readCount(me.followers_count, "followers_count");
    const follows = readCount(me.follows_count, "follows_count");
    const mediaCount = readCount(me.media_count, "media_count");
    const reasons = [followers, follows, mediaCount].map((r) => r.reason).filter(Boolean);

    let pinnedNow = false;
    try {
      // Refuse before opening the write transaction, then re-check under it (pin race).
      await assertTrackable(ctx.db, who, expect);
      await withTransaction(ctx.db, async (tx) => {
        pinnedNow = await pinOrVerify(tx, who, "account_sync", expect);
        await upsertAccount(tx, {
          igUserId,
          appScopedId: me.id ?? null,
          username: me.username!,
          accountType: me.account_type ?? null,
        });
        await tx.query(
          `INSERT INTO account_snapshots
             (ig_user_id, followers_count, followers_count_status, follows_count, follows_count_status,
              media_count, media_count_status, source, retrieved_at, sync_run_id, status_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (ig_user_id, sync_run_id) DO NOTHING`,
          [
            igUserId,
            followers.value,
            followers.status,
            follows.value,
            follows.status,
            mediaCount.value,
            mediaCount.status,
            SOURCES.instagramGraphApi,
            retrievedAt,
            runId,
            reasons.length ? reasons.join("; ") : null,
          ],
        );
      });
    } catch (err) {
      if (err instanceof AccountMismatchError) {
        await auditRefusal(ctx.db, "system", err, { syncRunId: runId });
        throw new SyncAbort(err.code, err.message, { pinnedIgUserId: err.pinnedIgUserId });
      }
      throw err;
    }

    return {
      igUserId,
      status: followers.status === "available" ? "succeeded" : "partial",
      stats: { followersCountStatus: followers.status, apiRequests: client.requestCount, pinnedNow },
      note:
        followers.status === "available"
          ? undefined
          : { code: "followers_count_" + followers.status, message: followers.reason ?? "followers_count missing" },
    };
  });
}

export async function upsertAccount(
  db: Queryable,
  a: { igUserId: string; appScopedId: string | null; username: string; accountType: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO ig_accounts (ig_user_id, app_scoped_id, username, account_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ig_user_id) DO UPDATE
       SET app_scoped_id = COALESCE(EXCLUDED.app_scoped_id, ig_accounts.app_scoped_id),
           username      = EXCLUDED.username,
           account_type  = COALESCE(EXCLUDED.account_type, ig_accounts.account_type),
           updated_at    = now()`,
    [a.igUserId, a.appScopedId, a.username, a.accountType],
  );
}

/** The account the dashboard tracks: the pinned id in tracked_account (null until pinned). */
export async function getTrackedAccountId(db: Queryable): Promise<string | null> {
  return getPinnedAccountId(db);
}

export const FOLLOWER_COUNT_INSIGHT = { metric: "follower_count", period: "day" } as const;
const INSIGHT_LOOKBACK_DAYS = 30;

export async function syncAccountInsights(ctx: SyncContext): Promise<SyncRunResult> {
  const now = nowFn(ctx);
  return runJob(ctx, "account_insights", async (runId, client) => {
    const igUserId = await verifyClientAccount(ctx.db, client);
    const until = now();
    const since = new Date(until.getTime() - INSIGHT_LOOKBACK_DAYS * 86_400_000);
    const { metric, period } = FOLLOWER_COUNT_INSIGHT;
    const points = await client.getUserInsightSeries(igUserId, metric, period, since, until);
    const retrievedAt = now();

    if (points === null) {
      return {
        igUserId,
        status: "partial",
        stats: { points: 0, inserted: 0, unchanged: 0, apiRequests: client.requestCount },
        note: {
          code: "empty_data_set",
          message: `API returned an empty data set for ${metric} (Meta: data does not exist or is unavailable)`,
        },
      };
    }

    let inserted = 0;
    let unchanged = 0;
    let invalid = 0;
    await withTransaction(ctx.db, async (tx) => {
      for (const p of points) {
        // follower_count is a count: anything but a non-negative safe integer is an 'error'.
        const v = validateMetricValue(metric, p.value);
        const status: AvailabilityStatus = v.kind === "value" ? "available" : v.kind === "absent" ? "unavailable" : "error";
        if (v.kind === "invalid") invalid++;
        const value = v.kind === "value" ? v.value : null;
        const reason = v.kind === "value" ? null : v.reason;
        const res = await tx.query(
          `INSERT INTO account_insight_observations
             (ig_user_id, metric, period, end_time, value, status, is_platform_estimated, source,
              retrieved_at, sync_run_id, status_reason)
           SELECT $1, $2, $3, $4, $5::numeric, $6, false, $7, $8, $9, $10
            WHERE NOT EXISTS (
              SELECT 1 FROM (
                SELECT value, status FROM account_insight_observations
                 WHERE ig_user_id = $1 AND metric = $2 AND period = $3 AND end_time = $4
                 ORDER BY retrieved_at DESC, id DESC LIMIT 1
              ) latest
              WHERE latest.status = $6 AND latest.value IS NOT DISTINCT FROM $5::numeric
            )
           ON CONFLICT DO NOTHING`,
          [igUserId, metric, period, p.endTime, value, status, SOURCES.instagramGraphApi, retrievedAt, runId, reason],
        );
        if (res.rowCount) inserted++;
        else unchanged++;
      }
    });
    return {
      igUserId,
      status: invalid > 0 ? "partial" : "succeeded",
      stats: { points: points.length, inserted, unchanged, invalid, apiRequests: client.requestCount },
      note: invalid > 0 ? { code: "invalid_values", message: `${invalid} ${metric} value(s) were not valid counts and were stored as 'error'` } : undefined,
    };
  });
}
