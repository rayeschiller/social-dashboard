import type pg from "pg";
import { ensurePinnedFromEnv } from "../account/tracked";
import { getInstagramConfig, requireExpectedUsername } from "../config";
import { clientFor, resolveAuth } from "../instagram/auth";
import type { InstagramClient } from "../instagram/client";
import { syncAccount, syncAccountInsights } from "./account";
import { syncMedia, syncMediaInsights } from "./media";
import type { SyncContext, SyncRunResult, SyncTrigger } from "./runs";
import { refreshTokenJob } from "./token";

export { syncAccount, syncAccountInsights } from "./account";
export { syncMedia, syncMediaInsights } from "./media";
export { refreshTokenJob } from "./token";
export type { SyncContext, SyncRunResult, SyncTrigger } from "./runs";

export type SyncJob = "account" | "media" | "token" | "all";

export const SYNC_JOBS: readonly SyncJob[] = ["account", "media", "token", "all"];

/**
 * Builds a context from env/DB credentials. A missing credential becomes `clientError`.
 * Fails closed: without IG_EXPECTED_USERNAME, or when IG_EXPECTED_USER_ID contradicts the pinned
 * account, every job records a failed run (code config_error / unexpected_account) and stores
 * nothing.
 */
export async function createSyncContext(
  db: pg.Pool,
  trigger: SyncTrigger,
  overrides: { client?: InstagramClient; now?: () => Date } = {},
): Promise<SyncContext> {
  const cfg = getInstagramConfig();
  const base = { db, trigger, now: overrides.now, expectedUsername: cfg.expectedUsername, expectedUserId: cfg.expectedUserId };
  try {
    requireExpectedUsername(cfg);
    await ensurePinnedFromEnv(db, cfg);
  } catch (err) {
    return { ...base, client: null, clientError: err as Error };
  }
  if (overrides.client) return { ...base, client: overrides.client };
  try {
    const auth = await resolveAuth(db, cfg);
    return { ...base, client: clientFor(auth, cfg) };
  } catch (err) {
    return { ...base, client: null, clientError: err as Error };
  }
}

/**
 * account: followers snapshot, then the follower_count daily insight
 * media:   media list (full backfill), then per-media insights
 * token:   long-lived token refresh (db mode only)
 * all:     token, account, media
 *
 * Insights steps only run if the step they depend on did not fail.
 */
export async function runSyncJob(ctx: SyncContext, job: SyncJob): Promise<SyncRunResult[]> {
  const results: SyncRunResult[] = [];
  if (job === "token" || job === "all") results.push(await refreshTokenJob(ctx));
  if (job === "account" || job === "all") {
    const acc = await syncAccount(ctx);
    results.push(acc);
    if (acc.status !== "failed") results.push(await syncAccountInsights(ctx));
  }
  if (job === "media" || job === "all") {
    const med = await syncMedia(ctx);
    results.push(med);
    if (med.status !== "failed") results.push(await syncMediaInsights(ctx));
  }
  return results;
}
