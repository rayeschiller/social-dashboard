/**
 * Adversarial review probes (from the independent review of the follower-tracking path), now part
 * of the permanent suite. Each test asserts the CORRECT behaviour per the product rules; a
 * failure is a regression of a reviewed defect. All numbers are SYNTHETIC fixtures.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GoalConfig, InstagramConfig } from "../../src/lib/config";
import { getGoalConfig } from "../../src/lib/config";
import { completeOAuthCallback } from "../../src/lib/instagram/connect";
import { planMediaInsights } from "../../src/lib/instagram/metrics";
import {
  currentFollowers,
  daysRemaining,
  followerHistory,
  mediaWithLatestMetrics,
  netGrowth,
  newFollowersDaily,
  requiredDailyPace,
  windowStart,
} from "../../src/lib/queries";
import { syncAccount, syncAccountInsights, syncMedia, syncMediaInsights, type SyncContext } from "../../src/lib/sync";
import type { InstagramClient } from "../../src/lib/instagram/client";
import { getActiveToken } from "../../src/lib/tokens/store";
import { startOfLocalDay } from "../../src/lib/time";
import { fakeClient, fakeFetch, graphError, insightsBody, type Route } from "../helpers/fake-graph";
import { insertAccount, insertRun, insertSnapshot } from "../helpers/seed";
import { closeTestPool, resetDb, testPool } from "../helpers/test-db";

const db = testPool();
const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = savedKey;
  await closeTestPool();
});
beforeEach(() => resetDb(db));

const goal: GoalConfig = { followers: 100_000, deadline: "2026-12-31", timezone: "America/New_York" };
const now = new Date("2026-11-15T17:00:00Z");
const ACCOUNT = "17840000000000001";
const ctxFor = (client: InstagramClient, extra: Partial<SyncContext> = {}): SyncContext => ({ db, client, trigger: "test", ...extra });
const meFor = (id: string, username: string, followers: unknown = 5000): Route => (u) =>
  u.pathname.endsWith("/me") ? { body: { user_id: id, id: `app-${id}`, username, followers_count: followers, follows_count: 1, media_count: 1 } } : undefined;

// ---------------------------------------------------------------------------------------------
// Rule 1: account followers only from the API followers_count field
// ---------------------------------------------------------------------------------------------
describe("R1 follower source", () => {
  // Original probe inserted a manual-source row and expected currentFollowers to ignore it. Fix #2
  // adds a CHECK so such a row can no longer exist at all, which made the original INSERT throw.
  // The probe is therefore split into (a) the schema rejects the row, and (b) the query layer
  // still ignores it and reports the real source when the CHECK is absent (dropped inside a
  // rolled-back transaction). Both halves are at least as strict as the original assertion.
  it("currentFollowers must ignore a non-API (manual) snapshot and never label it instagram_graph_api", async () => {
    const acct = await insertAccount(db);
    await insertSnapshot(db, acct, "2026-11-15T10:00:00Z", 5000);
    const runId = await insertRun(db, "account", new Date("2026-11-15T12:00:00Z"));
    const insertManual = (q: Pick<typeof db, "query">) =>
      q.query(
        `INSERT INTO account_snapshots (ig_user_id, followers_count, followers_count_status, follows_count_status,
           media_count_status, source, retrieved_at, sync_run_id, created_at)
         VALUES ($1, 66000, 'available', 'unavailable', 'unavailable', 'instagram_app_insights_manual', $2, $3, $2)`,
        [acct, new Date("2026-11-15T12:00:00Z"), runId],
      );
    // (a) the schema refuses it
    await expect(insertManual(db)).rejects.toThrow(/account_snapshots_source_api_only/);
    // (b) defence in depth: the queries filter on source even without the CHECK
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE account_snapshots DROP CONSTRAINT account_snapshots_source_api_only");
      await insertManual(client);
      const r = await currentFollowers({ db: client, now });
      expect(r).toMatchObject({ status: "available", value: 5000, source: "instagram_graph_api" });
      const hist = await followerHistory({ db: client, now, from: new Date("2026-11-15T00:00:00Z") });
      expect(hist.map((h) => h.followers)).toEqual([expect.objectContaining({ value: 5000, source: "instagram_graph_api" })]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 3: append-only enforcement
// ---------------------------------------------------------------------------------------------
describe("R3 append-only", () => {
  it("TRUNCATE on an observation table must be rejected", async () => {
    const acct = await insertAccount(db);
    await insertSnapshot(db, acct, "2026-11-15T10:00:00Z", 5000);
    await expect(db.query("TRUNCATE account_snapshots")).rejects.toThrow(/append-only/);
  });

  it("negative / fractional per-post follows must be rejected by the schema", async () => {
    const acct = await insertAccount(db);
    const runId = await insertRun(db, "media");
    await db.query(
      `INSERT INTO media (ig_media_id, ig_user_id, media_product_type, first_seen_at, last_seen_at, first_seen_sync_run_id, last_seen_sync_run_id)
       VALUES ('m1', $1, 'FEED', now(), now(), $2, $2)`,
      [acct, runId],
    );
    await expect(
      db.query(
        `INSERT INTO media_metric_observations (ig_media_id, metric, metric_origin, value, status, source, retrieved_at, sync_run_id)
         VALUES ('m1', 'follows', 'insight', -2.5, 'available', 'instagram_graph_api', now(), $1)`,
        [runId],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 6: malformed API values rejected, not stored
// ---------------------------------------------------------------------------------------------
describe("R6 malformed insight values", () => {
  const MEDIA = [{ id: "m-feed", media_type: "IMAGE", media_product_type: "FEED", permalink: "https://www.instagram.com/p/A1/", timestamp: "2026-11-01T10:00:00+0000" }];
  const mediaList: Route = (u) => (u.pathname.endsWith(`/${ACCOUNT}/media`) ? { body: { data: MEDIA } } : undefined);

  async function syncWithFollows(follows: number) {
    const insights: Route = (u) => {
      if (!u.pathname.endsWith("/insights")) return undefined;
      const metrics = (u.searchParams.get("metric") ?? "").split(",");
      return insightsBody(Object.fromEntries(metrics.map((m) => [m, m === "follows" ? follows : 1])));
    };
    const f = fakeClient([meFor(ACCOUNT, "synthetic_user"), mediaList, insights]);
    await syncAccount(ctxFor(f.client));
    await syncMedia(ctxFor(f.client));
    return syncMediaInsights(ctxFor(f.client));
  }

  for (const bad of [-3, 2.5]) {
    it(`follows=${bad} from the API must not be stored as 'available'`, async () => {
      await syncWithFollows(bad);
      const { rows } = await db.query("SELECT value, status FROM media_metric_observations WHERE metric = 'follows'");
      expect(rows[0].status).not.toBe("available");
    });
  }

  it("one huge follows value (1e300) must not make the whole media query throw", async () => {
    await syncWithFollows(1e300);
    await expect(mediaWithLatestMetrics({ db })).resolves.toBeDefined();
  });

  it("follower_count insight (new followers/day) must reject negatives and fractions", async () => {
    const series: Route = (u) =>
      u.pathname.endsWith(`/${ACCOUNT}/insights`)
        ? { body: { data: [{ name: "follower_count", period: "day", values: [{ end_time: "2026-11-14T08:00:00+0000", value: -7 }, { end_time: "2026-11-15T08:00:00+0000", value: 3.5 }] }] } }
        : undefined;
    const f = fakeClient([meFor(ACCOUNT, "synthetic_user"), series]);
    await syncAccount(ctxFor(f.client));
    await syncAccountInsights(ctxFor(f.client));
    const pts = await newFollowersDaily({ db });
    expect(pts.map((p) => p.newFollowers.status)).toEqual(["error", "error"]);
  });

  it("account followers_count: strings / floats / negatives / unsafe ints are rejected (control)", async () => {
    for (const bad of ["66K", "5000", 66.5, -1, 2 ** 53 + 2, 1e21]) {
      await resetDb(db);
      const f = fakeClient([meFor(ACCOUNT, "synthetic_user", bad)]);
      const run = await syncAccount(ctxFor(f.client));
      expect(run.status).toBe("partial");
      const { rows } = await db.query("SELECT followers_count, followers_count_status FROM account_snapshots");
      expect(rows).toEqual([{ followers_count: null, followers_count_status: "error" }]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 6/8: a token for a different account stores nothing
// ---------------------------------------------------------------------------------------------
describe("R6 other-account tokens", () => {
  it("syncAccount with no expectedUsername configured must not adopt a different account", async () => {
    const a = fakeClient([meFor(ACCOUNT, "tracked_user", 5000)]);
    await syncAccount(ctxFor(a.client, { expectedUsername: undefined }));
    const b = fakeClient([meFor("17840000000000999", "someone_else", 9_999_999)]);
    await syncAccount(ctxFor(b.client, { expectedUsername: undefined }));
    // Expected: the dashboard still reports the tracked account (or the second sync stored nothing).
    const r = await currentFollowers({ db, now: new Date(Date.now() + 1000) });
    expect(r.status === "available" && r.value).toBe(5000);
  });

  it("OAuth callback with IG_EXPECTED_USERNAME unset must refuse to store a token (fail closed)", async () => {
    const cfg: InstagramConfig = {
      apiVersion: "v27.0",
      graphBaseUrl: "https://graph.instagram.com",
      oauthBaseUrl: "https://api.instagram.com",
      authorizeUrl: "https://www.instagram.com/oauth/authorize",
      appId: "000000000000000",
      appSecret: "synthetic-app-secret",
      redirectUri: "https://dashboard.example/api/auth/instagram/callback",
      expectedUsername: undefined,
      authMode: "db",
    };
    const routes: Route[] = [
      (u) => (u.pathname.endsWith("/oauth/access_token") ? { body: { access_token: "SYNTH-short", user_id: 1, permissions: [] } } : undefined),
      (u) => (u.pathname.endsWith("/access_token") ? { body: { access_token: "SYNTH-long", expires_in: 5_184_000 } } : undefined),
      (u) => (u.pathname.endsWith("/me") ? { body: { user_id: "attacker-1", id: "x", username: "attacker" } } : undefined),
    ];
    const f = fakeFetch(routes);
    await completeOAuthCallback(db, cfg, { code: "c", state: "s", error: null, errorReason: null, cookieState: "s" }, f.fetch).catch(() => undefined);
    expect(await getActiveToken(db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 7: Reels never get a follows value from the API path
// ---------------------------------------------------------------------------------------------
describe("R7 Reels follows", () => {
  it("field-set fallback (no media_product_type) must not let a Reel get an API follows value", async () => {
    const reel = { id: "m-reel", media_type: "VIDEO", permalink: "https://www.instagram.com/reel/RRR/", timestamp: "2026-11-10T10:00:00+0000" };
    const strict: Route = (u) =>
      u.pathname.endsWith("/media") && (u.searchParams.get("fields") ?? "").includes("media_product_type")
        ? graphError(100, "(#100) Tried accessing nonexisting field (media_product_type)")
        : undefined;
    const list: Route = (u) => (u.pathname.endsWith(`/${ACCOUNT}/media`) ? { body: { data: [reel] } } : undefined);
    // An API that answers follows=0 for this item (no error). The app has no product type to check against.
    const insights: Route = (u) => {
      if (!u.pathname.endsWith("/insights")) return undefined;
      const metrics = (u.searchParams.get("metric") ?? "").split(",");
      return insightsBody(Object.fromEntries(metrics.map((m) => [m, 0])));
    };
    const f = fakeClient([meFor(ACCOUNT, "synthetic_user"), strict, list, insights]);
    await syncAccount(ctxFor(f.client));
    await syncMedia(ctxFor(f.client));
    await syncMediaInsights(ctxFor(f.client));
    const followsCalls = f.calls.filter((c) => c.url.pathname.includes("/m-reel/insights") && c.url.searchParams.get("metric") === "follows");
    const { rows } = await db.query("SELECT status, value FROM media_metric_observations WHERE ig_media_id='m-reel' AND metric='follows'");
    // Evidence: follows was requested for a /reel/ permalink and stored as available 0.
    expect({ followsCalls: followsCalls.length, row: rows[0] }).toEqual({ followsCalls: 0, row: expect.objectContaining({ status: "unsupported" }) });
  });

  it("query layer must report follows 'unsupported' for a REELS item even if an older available row exists", async () => {
    const acct = await insertAccount(db);
    const runId = await insertRun(db, "media_insights");
    await db.query(
      `INSERT INTO media (ig_media_id, ig_user_id, media_product_type, first_seen_at, last_seen_at, first_seen_sync_run_id, last_seen_sync_run_id)
       VALUES ('m-reel', $1, 'REELS', now(), now(), $2, $2)`,
      [acct, runId],
    );
    // e.g. written while media_product_type was still NULL (unknown) and the API answered
    await db.query(
      `INSERT INTO media_metric_observations (ig_media_id, metric, metric_origin, value, status, source, retrieved_at, sync_run_id)
       VALUES ('m-reel', 'follows', 'insight', 0, 'available', 'instagram_graph_api', now(), $1)`,
      [runId],
    );
    const [m] = await mediaWithLatestMetrics({ db });
    expect(m!.metrics.follows!.status).toBe("unsupported");
  });

  it("control: known REELS never requests follows", () => {
    expect(planMediaInsights("REELS").request).not.toContain("follows");
    expect(planMediaInsights("reels").request).not.toContain("follows");
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 2: stale value shown where the latest observation is missing
// ---------------------------------------------------------------------------------------------
describe("R2 stale per-post values", () => {
  it("latest media observation is 'error'/'unavailable' -> the metric must not show an older number", async () => {
    const acct = await insertAccount(db);
    const r1 = await insertRun(db, "media_insights", new Date("2026-11-01T00:00:00Z"));
    const r2 = await insertRun(db, "media_insights", new Date("2026-11-15T00:00:00Z"));
    await db.query(
      `INSERT INTO media (ig_media_id, ig_user_id, media_product_type, first_seen_at, last_seen_at, first_seen_sync_run_id, last_seen_sync_run_id)
       VALUES ('m-feed', $1, 'FEED', now(), now(), $2, $2)`,
      [acct, r1],
    );
    await db.query(
      `INSERT INTO media_metric_observations (ig_media_id, metric, metric_origin, value, status, source, retrieved_at, sync_run_id)
       VALUES ('m-feed','follows','insight',12,'available','instagram_graph_api','2026-11-01T00:00:00Z',$1),
              ('m-feed','follows','insight',NULL,'unavailable','instagram_graph_api','2026-11-15T00:00:00Z',$2)`,
      [r1, r2],
    );
    const [m] = await mediaWithLatestMetrics({ db });
    expect(m!.metrics.follows!.status).not.toBe("available");
  });
});

// ---------------------------------------------------------------------------------------------
// Rules 4/5: time edges (expected to PASS; kept as verification)
// ---------------------------------------------------------------------------------------------
describe("R4/R5 time edges (verification)", () => {
  it("DST end day and the day after", () => {
    expect(windowStart("day", new Date("2026-11-01T12:00:00Z"), goal.timezone).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(windowStart("day", new Date("2026-11-02T03:30:00Z"), goal.timezone).toISOString()).toBe("2026-11-01T04:00:00.000Z"); // 22:30 EST on Nov 1
    expect(windowStart("day", new Date("2026-11-02T05:00:00Z"), goal.timezone).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    // repeated 01:00-02:00 hour on Nov 1
    expect(windowStart("day", new Date("2026-11-01T06:30:00Z"), goal.timezone).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(windowStart("week", new Date("2026-11-01T12:00:00Z"), goal.timezone).toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(windowStart("week", new Date("2026-11-08T23:00:00Z"), goal.timezone).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(windowStart("month", new Date("2026-12-01T04:59:59Z"), goal.timezone).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(windowStart("month", new Date("2026-12-01T05:00:00Z"), goal.timezone).toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(windowStart("day", new Date("2026-03-08T12:00:00Z"), goal.timezone).toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("midnight that does not exist (America/Santiago DST start) still yields a window start inside that local day", () => {
    const tz = "America/Santiago";
    const d = startOfLocalDay({ year: 2026, month: 9, day: 6 }, tz);
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    expect(local).toBe("2026-09-06");
  });

  it("days remaining and pace edges", () => {
    expect(daysRemaining(new Date("2026-11-15T17:00:00Z"), goal).value).toBe(47);
    expect(daysRemaining(new Date("2027-01-01T04:59:59Z"), goal).value).toBe(1); // 23:59:59 EST Dec 31
    expect(daysRemaining(new Date("2027-01-01T05:00:00Z"), goal).value).toBe(0);
    expect(daysRemaining(new Date("2026-12-31T03:00:00Z"), goal).value).toBe(2); // still Dec 30 local
  });

  it("netGrowth: future-dated snapshots never used; per-account isolation", async () => {
    const a = await insertAccount(db, "acct-a", "a");
    const b = await insertAccount(db, "acct-b", "b");
    await insertSnapshot(db, a, "2026-11-15T04:00:00Z", 1000);
    await insertSnapshot(db, b, "2026-11-15T16:00:00Z", 999_999);
    await insertSnapshot(db, a, "2026-11-15T18:00:00Z", 1100); // after `now`
    const r = await netGrowth("day", { db, now, goal, igUserId: a });
    expect(r.status).toBe("unavailable");
  });

  it("pace after the deadline is unavailable, not Infinity / divide-by-zero", async () => {
    const acct = await insertAccount(db);
    await insertSnapshot(db, acct, "2027-01-01T06:00:00Z", 10);
    const r = await requiredDailyPace({ db, now: new Date("2027-01-01T07:00:00Z"), goal });
    expect(r.status).toBe("unavailable");
  });

  it("GOAL_DEADLINE with an impossible date must be rejected", () => {
    expect(() => getGoalConfig({ GOAL_DEADLINE: "2026-02-31" } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 8: concurrency (expected to PASS)
// ---------------------------------------------------------------------------------------------
describe("R8 concurrency (verification)", () => {
  it("two concurrent account syncs: exactly one writes, the other is skipped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowFetch = fakeFetch([meFor(ACCOUNT, "synthetic_user")]);
    const { InstagramClient } = await import("../../src/lib/instagram/client");
    const mk = () =>
      new InstagramClient({
        accessToken: "synthetic",
        authMode: "env",
        fetchImpl: (async (...args: Parameters<typeof fetch>) => {
          await gate;
          return slowFetch.fetch(...args);
        }) as typeof fetch,
      });
    const p1 = syncAccount(ctxFor(mk()));
    const p2 = syncAccount(ctxFor(mk()));
    await new Promise((r) => setTimeout(r, 200));
    release();
    const runs = await Promise.all([p1, p2]);
    expect(runs.map((r) => r.status).sort()).toEqual(["skipped", "succeeded"]);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM account_snapshots");
    expect(rows[0].n).toBe(1);
  });
});
