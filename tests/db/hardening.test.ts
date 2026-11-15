/**
 * Regression tests for the fixes made after the follower-tracking review: account pinning,
 * value validation, Reels/unknown product types, latest-observation semantics, append-only
 * hardening, stale runs, snapshot age and per-day net growth. All numbers are SYNTHETIC.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GoalConfig, InstagramConfig } from "../../src/lib/config";
import { completeOAuthCallback } from "../../src/lib/instagram/connect";
import {
  currentFollowers,
  getPinnedAccountId,
  mediaWithLatestMetrics,
  netGrowthForLocalDay,
  previousLocalDate,
} from "../../src/lib/queries";
import {
  createSyncContext,
  runSyncJob,
  syncAccount,
  syncMedia,
  syncMediaInsights,
  type SyncContext,
} from "../../src/lib/sync";
import type { InstagramClient } from "../../src/lib/instagram/client";
import { getActiveToken, storeToken } from "../../src/lib/tokens/store";
import { fakeClient, fakeFetch, insightsBody, type Route } from "../helpers/fake-graph";
import { insertAccount, insertRun, insertSnapshot } from "../helpers/seed";
import { closeTestPool, resetDb, testPool } from "../helpers/test-db";

const db = testPool();
const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  for (const k of ["IG_EXPECTED_USERNAME", "IG_EXPECTED_USER_ID", "IG_AUTH_MODE", "IG_ACCESS_TOKEN"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
afterAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = savedEnv.TOKEN_ENCRYPTION_KEY;
  await closeTestPool();
});
beforeEach(() => resetDb(db));

const ACCOUNT = "17840000000000001";
const OTHER = "17840000000000999";
const goal: GoalConfig = { followers: 100_000, deadline: "2026-12-31", timezone: "America/New_York" };
const ctxFor = (client: InstagramClient, extra: Partial<SyncContext> = {}): SyncContext => ({
  db,
  client,
  trigger: "test",
  expectedUsername: "tracked_user",
  ...extra,
});
const meFor = (id: string, username: string, followers: unknown = 5000): Route => (u) =>
  u.pathname.endsWith("/me") ? { body: { user_id: id, id: `app-${id}`, username, followers_count: followers, follows_count: 1, media_count: 1 } } : undefined;
const count = async (table: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
const auditActions = async () => (await db.query<{ action: string }>("SELECT action FROM audit_log ORDER BY id")).rows.map((r) => r.action);

const oauthCfg: InstagramConfig = {
  apiVersion: "v27.0",
  graphBaseUrl: "https://graph.instagram.com",
  oauthBaseUrl: "https://api.instagram.com",
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  appId: "000000000000000",
  appSecret: "synthetic-app-secret",
  redirectUri: "https://dashboard.example/api/auth/instagram/callback",
  expectedUsername: "tracked_user",
  authMode: "db",
};
const oauthRoutes = (id: string, username: string): Route[] => [
  (u) => (u.host === "api.instagram.com" ? { body: { access_token: "SYNTH-short", user_id: 1, permissions: [] } } : undefined),
  (u) => (u.pathname === "/access_token" ? { body: { access_token: `SYNTH-long-${id}`, expires_in: 5_184_000 } } : undefined),
  (u) => (u.pathname.endsWith("/me") ? { body: { user_id: id, id: `app-${id}`, username } } : undefined),
];
const callback = (id: string, username: string, cfg: InstagramConfig = oauthCfg) =>
  completeOAuthCallback(db, cfg, { code: "c", state: "s", error: null, errorReason: null, cookieState: "s" }, fakeFetch(oauthRoutes(id, username)).fetch);

// -------------------------------------------------------------------------------------------------
describe("account pinning", () => {
  it("the first account sync pins the stable id; a later token for another id is refused and audited", async () => {
    const run1 = await syncAccount(ctxFor(fakeClient([meFor(ACCOUNT, "tracked_user")]).client));
    expect(run1.status).toBe("succeeded");
    expect(await getPinnedAccountId(db)).toBe(ACCOUNT);

    // Same username, different stable id (e.g. the handle was released and re-registered).
    const run2 = await syncAccount(ctxFor(fakeClient([meFor(OTHER, "tracked_user", 9_999_999)]).client));
    expect(run2).toMatchObject({ status: "failed", errorCode: "unexpected_account" });
    expect(await count("account_snapshots")).toBe(1);
    expect((await db.query("SELECT ig_user_id FROM ig_accounts")).rows).toEqual([{ ig_user_id: ACCOUNT }]);
    expect(await auditActions()).toEqual(["tracked_account_pinned", "tracked_account_mismatch_rejected"]);
    const { rows } = await db.query("SELECT status, ig_user_id FROM sync_runs WHERE id = $1", [run2.id]);
    expect(rows[0]).toEqual({ status: "failed", ig_user_id: null });
  });

  it("after pinning, the stable id (not the username) is compared: a renamed account keeps syncing", async () => {
    await syncAccount(ctxFor(fakeClient([meFor(ACCOUNT, "tracked_user")]).client));
    const run = await syncAccount(ctxFor(fakeClient([meFor(ACCOUNT, "renamed_user", 5100)]).client));
    expect(run.status).toBe("succeeded");
    expect(await count("account_snapshots")).toBe(2);
  });

  it("does not pin an account whose username or id does not match the expectations", async () => {
    const r1 = await syncAccount(ctxFor(fakeClient([meFor(OTHER, "someone_else")]).client));
    expect(r1).toMatchObject({ status: "failed", errorCode: "unexpected_account" });
    const r2 = await syncAccount(ctxFor(fakeClient([meFor(OTHER, "tracked_user")]).client, { expectedUserId: ACCOUNT }));
    expect(r2).toMatchObject({ status: "failed", errorCode: "unexpected_account" });
    expect(await getPinnedAccountId(db)).toBeNull();
    expect(await count("account_snapshots")).toBe(0);
  });

  it("OAuth pins on first connect and refuses a token for a different id afterwards", async () => {
    await expect(callback(ACCOUNT, "tracked_user")).resolves.toMatchObject({ igUserId: ACCOUNT });
    expect(await getPinnedAccountId(db)).toBe(ACCOUNT);
    await expect(callback(OTHER, "tracked_user")).rejects.toMatchObject({ code: "unexpected_account" });
    const tokens = await db.query("SELECT ig_user_id FROM oauth_tokens");
    expect(tokens.rows).toEqual([{ ig_user_id: ACCOUNT }]);
    expect(await auditActions()).toContain("instagram_connect_rejected");
    expect((await getActiveToken(db))?.accessToken).toBe(`SYNTH-long-${ACCOUNT}`);
  });

  it("OAuth refuses (before any network call) when IG_EXPECTED_USERNAME is unset", async () => {
    const f = fakeFetch(oauthRoutes(ACCOUNT, "tracked_user"));
    await expect(
      completeOAuthCallback(db, { ...oauthCfg, expectedUsername: undefined }, { code: "c", state: "s", error: null, errorReason: null, cookieState: "s" }, f.fetch),
    ).rejects.toMatchObject({ code: "config_error" });
    expect(f.calls).toHaveLength(0);
  });

  it("the pin is immutable", async () => {
    await insertAccount(db, ACCOUNT, "tracked_user");
    await expect(db.query("UPDATE tracked_account SET ig_user_id = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM tracked_account")).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE tracked_account")).rejects.toThrow(/append-only/);
    await expect(
      db.query("INSERT INTO tracked_account (ig_user_id, pinned_via) VALUES ('other', 'env')"),
    ).rejects.toThrow(/duplicate key/);
  });

  it("media and media-insights jobs verify that the token belongs to the pinned account", async () => {
    await syncAccount(ctxFor(fakeClient([meFor(ACCOUNT, "tracked_user")]).client));
    const foreign = fakeClient([
      meFor(OTHER, "someone_else"),
      (u) => (u.pathname.endsWith("/media") ? { body: { data: [{ id: "m1", media_product_type: "FEED" }] } } : undefined),
    ]);
    const media = await syncMedia(ctxFor(foreign.client));
    expect(media).toMatchObject({ status: "failed", errorCode: "unexpected_account" });
    const ins = await syncMediaInsights(ctxFor(foreign.client));
    expect(ins).toMatchObject({ status: "failed", errorCode: "unexpected_account" });
    expect(foreign.calls.filter((c) => !c.url.pathname.endsWith("/me"))).toHaveLength(0);
    expect(await count("media")).toBe(0);
  });

  it("getActiveToken only ever returns the tracked account's token", async () => {
    await insertAccount(db, ACCOUNT, "tracked_user");
    await insertAccount(db, OTHER, "someone_else", false);
    await storeToken(db, { igUserId: OTHER, accessToken: "SYNTH-other", scopes: [], issuedAt: new Date(), expiresInSeconds: 3600, obtainedVia: "oauth_callback" });
    expect(await getActiveToken(db)).toBeNull();
    await storeToken(db, { igUserId: ACCOUNT, accessToken: "SYNTH-mine", scopes: [], issuedAt: new Date(Date.now() - 1000), expiresInSeconds: 3600, obtainedVia: "oauth_callback" });
    expect((await getActiveToken(db))?.accessToken).toBe("SYNTH-mine");
  });

  it("queries use the pinned account, never the most recently updated ig_accounts row", async () => {
    expect((await currentFollowers({ db })).status).toBe("unavailable"); // nothing pinned
    await insertAccount(db, ACCOUNT, "tracked_user");
    await insertSnapshot(db, ACCOUNT, "2026-11-15T04:00:00Z", 5000);
    await insertAccount(db, OTHER, "someone_else", false);
    await insertSnapshot(db, OTHER, "2026-11-15T05:00:00Z", 9_999_999);
    await db.query("UPDATE ig_accounts SET updated_at = now() + interval '1 hour' WHERE ig_user_id = $1", [OTHER]);
    const r = await currentFollowers({ db, now: new Date("2026-11-15T06:00:00Z") });
    expect(r).toMatchObject({ status: "available", value: 5000 });
  });
});

describe("entry points fail closed", () => {
  it("without IG_EXPECTED_USERNAME every job records a failed run and stores nothing", async () => {
    delete process.env.IG_EXPECTED_USERNAME;
    delete process.env.IG_EXPECTED_USER_ID;
    const ctx = await createSyncContext(db, "cli", { client: fakeClient([meFor(ACCOUNT, "tracked_user")]).client });
    const runs = await runSyncJob(ctx, "all");
    expect(runs.map((r) => [r.kind, r.status, r.errorCode])).toEqual([
      ["token_refresh", "failed", "config_error"],
      ["account", "failed", "config_error"],
      ["media", "failed", "config_error"],
    ]);
    expect(runs[1]!.errorMessage).toMatch(/IG_EXPECTED_USERNAME is not set/);
    expect(await count("account_snapshots")).toBe(0);
    expect(await getPinnedAccountId(db)).toBeNull();
  });

  it("IG_EXPECTED_USER_ID pre-pins; a token for another id is then refused even with the right username", async () => {
    process.env.IG_EXPECTED_USERNAME = "tracked_user";
    process.env.IG_EXPECTED_USER_ID = ACCOUNT;
    const ctx = await createSyncContext(db, "cli", { client: fakeClient([meFor(OTHER, "tracked_user")]).client });
    expect(await getPinnedAccountId(db)).toBe(ACCOUNT);
    const [run] = await runSyncJob(ctx, "account");
    expect(run).toMatchObject({ status: "failed", errorCode: "unexpected_account" });
    expect(await count("account_snapshots")).toBe(0);
  });

  it("IG_EXPECTED_USER_ID contradicting the stored pin fails every job", async () => {
    await insertAccount(db, ACCOUNT, "tracked_user");
    process.env.IG_EXPECTED_USERNAME = "tracked_user";
    process.env.IG_EXPECTED_USER_ID = OTHER;
    const ctx = await createSyncContext(db, "cli", { client: fakeClient([meFor(ACCOUNT, "tracked_user")]).client });
    const runs = await runSyncJob(ctx, "account");
    expect(runs.map((r) => r.errorCode)).toEqual(["unexpected_account"]);
    expect(await count("account_snapshots")).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
describe("value validation", () => {
  const MEDIA = [
    { id: "m-feed", media_type: "IMAGE", media_product_type: "FEED", permalink: "https://www.instagram.com/p/A1/", timestamp: "2026-11-01T10:00:00+0000", like_count: -1, comments_count: 2.5 },
    { id: "m-reel", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://www.instagram.com/reel/R1/", timestamp: "2026-11-02T10:00:00+0000", like_count: 3, comments_count: 0 },
  ];
  const mediaList: Route = (u) => (u.pathname.endsWith(`/${ACCOUNT}/media`) ? { body: { data: MEDIA } } : undefined);

  it("fields and insights: counts must be whole and non-negative; durations/percent may be fractional but bounded", async () => {
    const insights: Route = (u) => {
      if (!u.pathname.endsWith("/insights")) return undefined;
      const metrics = (u.searchParams.get("metric") ?? "").split(",");
      const v: Record<string, number> = { ig_reels_avg_watch_time: 1234.5, reels_skip_rate: 150, views: 10, reach: 2.5 };
      return insightsBody(Object.fromEntries(metrics.map((m) => [m, v[m] ?? 1])));
    };
    const f = fakeClient([meFor(ACCOUNT, "tracked_user"), mediaList, insights]);
    await syncAccount(ctxFor(f.client));
    await syncMedia(ctxFor(f.client));
    const run = await syncMediaInsights(ctxFor(f.client));
    expect(run.status).toBe("partial");
    const { rows } = await db.query<{ ig_media_id: string; metric: string; value: number | null; status: string; status_reason: string | null }>(
      "SELECT ig_media_id, metric, value, status, status_reason FROM media_metric_observations",
    );
    const get = (id: string, m: string) => rows.find((r) => r.ig_media_id === id && r.metric === m)!;
    expect(get("m-feed", "like_count")).toMatchObject({ value: null, status: "error" });
    expect(get("m-feed", "comments_count")).toMatchObject({ value: null, status: "error" });
    expect(get("m-reel", "ig_reels_avg_watch_time")).toMatchObject({ value: 1234.5, status: "available" });
    expect(get("m-reel", "reels_skip_rate")).toMatchObject({ value: null, status: "error" });
    expect(get("m-reel", "reels_skip_rate").status_reason).toMatch(/percentage above 100/);
    expect(get("m-reel", "reach")).toMatchObject({ value: null, status: "error" });
    expect(get("m-reel", "views")).toMatchObject({ value: 10, status: "available" });
  });

  it("the schema rejects out-of-range, fractional-count and future-dated observations", async () => {
    const acct = await insertAccount(db);
    const runId = await insertRun(db, "media");
    await db.query(
      `INSERT INTO media (ig_media_id, ig_user_id, media_product_type, first_seen_at, last_seen_at, first_seen_sync_run_id, last_seen_sync_run_id)
       VALUES ('m1', $1, 'REELS', now(), now(), $2, $2)`,
      [acct, runId],
    );
    const ins = (metric: string, value: string, retrievedAt = "now()") =>
      db.query(
        `INSERT INTO media_metric_observations (ig_media_id, metric, metric_origin, value, status, source, retrieved_at, sync_run_id)
         VALUES ('m1', $1, 'insight', $2::numeric, 'available', 'instagram_graph_api', ${retrievedAt}, $3)`,
        [metric, value, runId],
      );
    await expect(ins("views", "1e16")).rejects.toThrow(/value_range/);
    await expect(ins("views", "NaN")).rejects.toThrow(/value_range/);
    await expect(ins("views", "-1")).rejects.toThrow(/value_range/);
    await expect(ins("views", "1.5")).rejects.toThrow(/value_integer/);
    await expect(ins("reels_skip_rate", "100.5")).rejects.toThrow(/percent_max/);
    await expect(ins("views", "1", "now() + interval '1 hour'")).rejects.toThrow(/retrieved_at_not_future/);
    await expect(ins("ig_reels_avg_watch_time", "1234.5")).resolves.toBeDefined();

    await expect(
      db.query(
        `INSERT INTO account_insight_observations (ig_user_id, metric, period, end_time, value, status, source, retrieved_at, sync_run_id)
         VALUES ($1, 'follower_count', 'day', now(), 2.5, 'available', 'instagram_graph_api', now(), $2)`,
        [acct, runId],
      ),
    ).rejects.toThrow(/value_integer/);
    await expect(
      db.query(
        `INSERT INTO account_snapshots (ig_user_id, followers_count, followers_count_status, follows_count_status, media_count_status, source, retrieved_at, sync_run_id)
         VALUES ($1, 10, 'available', 'unavailable', 'unavailable', 'instagram_graph_api', now() + interval '1 day', $2)`,
        [acct, runId],
      ),
    ).rejects.toThrow(/retrieved_at_not_future/);
  });

  it("TRUNCATE is rejected on every append-only table", async () => {
    for (const t of ["account_snapshots", "account_insight_observations", "media_metric_observations", "audit_log", "tracked_account"]) {
      await expect(db.query(`TRUNCATE ${t} CASCADE`)).rejects.toThrow(/append-only/);
    }
    await expect(db.query("TRUNCATE ig_accounts CASCADE")).rejects.toThrow(/append-only/);
  });
});

// -------------------------------------------------------------------------------------------------
describe("unknown product type", () => {
  it("never requests follows/profile_visits/profile_activity and stores them 'unavailable' (product type unknown)", async () => {
    const item = { id: "m-x", media_type: "IMAGE", permalink: "https://www.instagram.com/p/XYZ/", timestamp: "2026-11-10T10:00:00+0000" };
    const list: Route = (u) => (u.pathname.endsWith(`/${ACCOUNT}/media`) ? { body: { data: [item] } } : undefined);
    const insights: Route = (u) => (u.pathname.endsWith("/insights") ? insightsBody({ [u.searchParams.get("metric")!]: 4 }) : undefined);
    const f = fakeClient([meFor(ACCOUNT, "tracked_user"), list, insights]);
    await syncAccount(ctxFor(f.client));
    await syncMedia(ctxFor(f.client));
    await syncMediaInsights(ctxFor(f.client));
    const requested = f.calls.filter((c) => c.url.pathname.endsWith("/insights")).map((c) => c.url.searchParams.get("metric"));
    expect(requested).not.toContain("follows");
    expect(requested).not.toContain("profile_visits");
    expect(requested).not.toContain("profile_activity");
    const { rows } = await db.query(
      "SELECT metric, status, value, status_reason FROM media_metric_observations WHERE metric IN ('follows','profile_visits','profile_activity') ORDER BY metric",
    );
    expect(rows).toEqual(
      ["follows", "profile_activity", "profile_visits"].map((metric) => ({ metric, status: "unavailable", value: null, status_reason: "product type unknown" })),
    );
    const [m] = await mediaWithLatestMetrics({ db });
    expect(m!.metrics.follows).toMatchObject({ status: "unavailable", reason: "product type unknown" });
    expect(m!.metrics.views).toMatchObject({ status: "available", value: 4 });
  });
});

// -------------------------------------------------------------------------------------------------
describe("mediaWithLatestMetrics: latest observation + lastAvailable", () => {
  async function setup(productType = "FEED") {
    const acct = await insertAccount(db);
    const r1 = await insertRun(db, "media_insights", new Date("2026-11-01T00:00:00Z"));
    const r2 = await insertRun(db, "media_insights", new Date("2026-11-10T00:00:00Z"));
    await db.query(
      `INSERT INTO media (ig_media_id, ig_user_id, media_product_type, first_seen_at, last_seen_at, first_seen_sync_run_id, last_seen_sync_run_id)
       VALUES ('m1', $1, $2, now(), now(), $3, $3)`,
      [acct, productType, r1],
    );
    return { r1, r2 };
  }
  const obs = (metric: string, value: number | null, status: string, at: string, run: number) =>
    db.query(
      `INSERT INTO media_metric_observations (ig_media_id, metric, metric_origin, value, status, source, retrieved_at, sync_run_id, status_reason)
       VALUES ('m1', $1, 'insight', $2, $3, 'instagram_graph_api', $4, $5, $6)`,
      [metric, value, status, at, run, status === "available" ? null : `synthetic ${status}`],
    );

  it("shows the newer non-available status and exposes the older value separately", async () => {
    const { r1, r2 } = await setup();
    await obs("views", 120, "available", "2026-11-01T00:00:00Z", r1);
    await obs("views", null, "error", "2026-11-10T00:00:00Z", r2);
    await obs("reach", 50, "available", "2026-11-10T00:00:00Z", r2);
    const [m] = await mediaWithLatestMetrics({ db });
    expect(m!.metrics.views).toMatchObject({ status: "error", reason: "synthetic error" });
    expect(m!.metrics.views!.lastAvailable).toEqual({ value: 120, source: "instagram_graph_api", retrievedAt: new Date("2026-11-01T00:00:00Z"), syncRunId: r1 });
    expect(m!.metrics.reach).toMatchObject({ status: "available", value: 50 });
    expect(m!.metrics.reach!.lastAvailable).toBeUndefined();
  });

  it("a REELS item never exposes a follows value, not even as lastAvailable", async () => {
    const { r1 } = await setup("REELS");
    await obs("follows", 7, "available", "2026-11-01T00:00:00Z", r1);
    const [m] = await mediaWithLatestMetrics({ db });
    expect(m!.metrics.follows).toMatchObject({ status: "unsupported" });
    expect(m!.metrics.follows!.lastAvailable).toBeUndefined();
  });

  it("one unreadable stored value only affects its own metric", async () => {
    const { r1 } = await setup();
    await obs("reach", 9, "available", "2026-11-01T00:00:00Z", r1);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE media_metric_observations DROP CONSTRAINT media_metric_observations_value_range");
      await client.query(
        `INSERT INTO media_metric_observations (ig_media_id, metric, metric_origin, value, status, source, retrieved_at, sync_run_id)
         VALUES ('m1', 'views', 'insight', 1e300, 'available', 'instagram_graph_api', '2026-11-01T00:00:00Z', $1)`,
        [r1],
      );
      const [m] = await mediaWithLatestMetrics({ db: client });
      expect(m!.metrics.views).toMatchObject({ status: "error" });
      expect(m!.metrics.reach).toMatchObject({ status: "available", value: 9 });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// -------------------------------------------------------------------------------------------------
describe("stale sync runs", () => {
  it("a run stuck in 'running' beyond the timeout is marked failed (timed out) by the next run of its kind", async () => {
    const old = await db.query<{ id: number }>(
      "INSERT INTO sync_runs (kind, trigger, started_at) VALUES ('account', 'test', now() - interval '2 hours') RETURNING id",
    );
    const recent = await db.query<{ id: number }>(
      "INSERT INTO sync_runs (kind, trigger, started_at) VALUES ('account', 'test', now() - interval '5 minutes') RETURNING id",
    );
    const otherKind = await db.query<{ id: number }>(
      "INSERT INTO sync_runs (kind, trigger, started_at) VALUES ('media', 'test', now() - interval '2 hours') RETURNING id",
    );
    await syncAccount(ctxFor(fakeClient([meFor(ACCOUNT, "tracked_user")]).client));
    const { rows } = await db.query("SELECT id, status, error_code, error_message, finished_at IS NOT NULL AS finished FROM sync_runs WHERE id = ANY($1) ORDER BY id", [
      [old.rows[0]!.id, recent.rows[0]!.id, otherKind.rows[0]!.id],
    ]);
    expect(rows).toEqual([
      { id: old.rows[0]!.id, status: "failed", error_code: "timed_out", error_message: "timed out", finished: true },
      { id: recent.rows[0]!.id, status: "running", error_code: null, error_message: null, finished: false },
      { id: otherKind.rows[0]!.id, status: "running", error_code: null, error_message: null, finished: false },
    ]);
  });
});

// -------------------------------------------------------------------------------------------------
describe("currentFollowers snapshot age", () => {
  it("reports snapshotAgeHours and stale", async () => {
    const acct = await insertAccount(db);
    await insertSnapshot(db, acct, "2026-11-15T07:00:00Z", 5000);
    const fresh = await currentFollowers({ db, now: new Date("2026-11-15T08:30:00Z") });
    expect(fresh).toMatchObject({ status: "available", value: 5000, snapshotAgeHours: 1.5, stale: false });
    const old = await currentFollowers({ db, now: new Date("2026-11-15T17:00:00Z") });
    expect(old).toMatchObject({ snapshotAgeHours: 10, stale: true });
  });
});

// -------------------------------------------------------------------------------------------------
describe("netGrowthForLocalDay", () => {
  const now = new Date("2026-11-15T17:00:00Z");
  let acct: string;
  beforeEach(async () => {
    acct = await insertAccount(db);
  });

  it("previousLocalDate is yesterday in the reporting timezone", () => {
    expect(previousLocalDate(now, goal.timezone)).toBe("2026-11-14");
    expect(previousLocalDate(new Date("2026-11-15T03:00:00Z"), goal.timezone)).toBe("2026-11-13"); // 22:00 on the 14th local
  });

  it("is the latest snapshot at-or-before day end minus the latest at-or-before day start", async () => {
    await insertSnapshot(db, acct, "2026-11-14T03:00:00Z", 5000); // 22:00 on the 13th local, 2h before start
    await insertSnapshot(db, acct, "2026-11-14T05:00:01Z", 5005); // just after start: not a baseline
    await insertSnapshot(db, acct, "2026-11-14T20:00:00Z", 5050);
    await insertSnapshot(db, acct, "2026-11-15T04:00:00Z", 5100); // 23:00 on the 14th local
    await insertSnapshot(db, acct, "2026-11-15T05:00:01Z", 5200); // after day end: ignored
    const r = await netGrowthForLocalDay("2026-11-14", { db, now, goal });
    expect(r.status).toBe("available");
    if (r.status !== "available") return;
    expect(r.value).toMatchObject({ date: "2026-11-14", delta: 100, dayLengthHours: 24, timezone: "America/New_York", toleranceHours: 6 });
    expect(r.value.dayStart.toISOString()).toBe("2026-11-14T05:00:00.000Z");
    expect(r.value.dayEnd.toISOString()).toBe("2026-11-15T05:00:00.000Z");
    expect(r.value.start.retrievedAt.toISOString()).toBe("2026-11-14T03:00:00.000Z");
    expect(r.value.end.retrievedAt.toISOString()).toBe("2026-11-15T04:00:00.000Z");
    expect(r.value.start.source).toBe("instagram_graph_api");
    expect(r.source).toBe("derived_from_snapshots");
  });

  it("handles the 25-hour DST day 2026-11-01 (EDT -> EST)", async () => {
    await insertSnapshot(db, acct, "2026-11-01T02:00:00Z", 4000); // 22:00 EDT Oct 31
    await insertSnapshot(db, acct, "2026-11-01T04:00:00Z", 4001); // exactly local 00:00 EDT -> baseline
    await insertSnapshot(db, acct, "2026-11-02T04:30:00Z", 4030); // 23:30 EST Nov 1
    await insertSnapshot(db, acct, "2026-11-02T05:30:00Z", 4999); // 00:30 EST Nov 2: next day
    const r = await netGrowthForLocalDay("2026-11-01", { db, now, goal });
    expect(r.status).toBe("available");
    if (r.status !== "available") return;
    expect(r.value.dayStart.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(r.value.dayEnd.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(r.value.dayLengthHours).toBe(25);
    expect(r.value.delta).toBe(29);
    expect(r.value.start.followers).toBe(4001);
    expect(r.value.end.followers).toBe(4030);
  });

  it("is unavailable for a day that has not ended, or when either boundary snapshot is missing", async () => {
    await insertSnapshot(db, acct, "2026-11-15T04:00:00Z", 5100);
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5150);
    const today = await netGrowthForLocalDay("2026-11-15", { db, now, goal });
    expect(today).toMatchObject({ status: "unavailable" });
    expect(today.status !== "available" && today.reason).toMatch(/has not ended/);

    // 2026-11-14: end snapshot exists (04:00Z on the 15th) but no baseline near the 14th's start
    const noStart = await netGrowthForLocalDay("2026-11-14", { db, now, goal });
    expect(noStart.status !== "available" && noStart.reason).toMatch(/before the start of 2026-11-14/);

    // 2026-11-13: neither boundary has a snapshot
    await insertSnapshot(db, acct, "2026-11-13T04:00:00Z", 5000);
    const noEnd = await netGrowthForLocalDay("2026-11-13", { db, now, goal });
    expect(noEnd.status !== "available" && noEnd.reason).toMatch(/before the end of 2026-11-13/);
  });

  it("rejects an impossible date", async () => {
    expect((await netGrowthForLocalDay("2026-02-30", { db, now, goal })).status).toBe("error");
  });
});
