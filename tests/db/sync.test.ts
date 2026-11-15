/**
 * Sync engine against the real local Postgres with a scripted fake of graph.instagram.com.
 * Every number returned by the fake is a SYNTHETIC fixture defined in this file.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mediaWithLatestMetrics } from "../../src/lib/queries";
import { formatMetric } from "../../src/lib/provenance";
import { syncAccount, syncAccountInsights, syncMedia, syncMediaInsights, type SyncContext } from "../../src/lib/sync";
import type { InstagramClient } from "../../src/lib/instagram/client";
import { fakeClient, graphError, insightsBody, type Route } from "../helpers/fake-graph";
import { closeTestPool, resetDb, testPool } from "../helpers/test-db";

const db = testPool();
afterAll(closeTestPool);
beforeEach(() => resetDb(db));

const ACCOUNT = "17840000000000001"; // synthetic id
const me: Route = (u) =>
  u.pathname.endsWith("/me")
    ? { body: { user_id: ACCOUNT, id: "app-scoped-1", username: "synthetic_user", account_type: "MEDIA_CREATOR", followers_count: 0, follows_count: 3, media_count: 2 } }
    : undefined;

const MEDIA_PAGE_1 = [
  { id: "m-feed", media_type: "IMAGE", media_product_type: "FEED", permalink: "https://www.instagram.com/p/FEEDcode1/", shortcode: "FEEDcode1", timestamp: "2026-11-01T10:00:00+0000", like_count: 5, comments_count: 0 },
];
const MEDIA_PAGE_2 = [
  // shortcode deliberately absent: must be parsed from the permalink
  { id: "m-reel", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://www.instagram.com/reel/REELcode2/", timestamp: "2026-11-10T10:00:00+0000", like_count: 9 },
];
const mediaList: Route = (u) => {
  if (!u.pathname.endsWith(`/${ACCOUNT}/media`)) return undefined;
  if (u.searchParams.get("after") === "p2") return { body: { data: MEDIA_PAGE_2 } };
  return { body: { data: MEDIA_PAGE_1, paging: { next: `https://graph.instagram.com/v27.0/${ACCOUNT}/media?after=p2` } } };
};

function ctxFor(client: InstagramClient): SyncContext {
  return { db, client, trigger: "test" };
}

async function count(table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe("syncAccount", () => {
  it("stores followers_count exactly, including a real 0, with provenance", async () => {
    const { client } = fakeClient([me]);
    const run = await syncAccount(ctxFor(client));
    expect(run.status).toBe("succeeded");
    const { rows } = await db.query("SELECT * FROM account_snapshots");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ig_user_id: ACCOUNT,
      followers_count: 0,
      followers_count_status: "available",
      source: "instagram_graph_api",
      sync_run_id: run.id,
    });
    expect(rows[0].retrieved_at).toBeInstanceOf(Date);
  });

  it("stores NULL + 'unavailable' when followers_count is missing (never 0)", async () => {
    const { client } = fakeClient([(u) => (u.pathname.endsWith("/me") ? { body: { user_id: ACCOUNT, username: "synthetic_user" } } : undefined)]);
    const run = await syncAccount(ctxFor(client));
    expect(run.status).toBe("partial");
    const { rows } = await db.query("SELECT followers_count, followers_count_status FROM account_snapshots");
    expect(rows[0]).toEqual({ followers_count: null, followers_count_status: "unavailable" });
  });

  it("writes no snapshot and fails the run on an API error", async () => {
    const { client } = fakeClient([() => graphError(190, "Invalid OAuth access token - Cannot parse access token", 401)]);
    const run = await syncAccount(ctxFor(client));
    expect(run).toMatchObject({ status: "failed", errorCode: "ig_190" });
    expect(await count("account_snapshots")).toBe(0);
    expect(await count("api_errors")).toBe(1);
  });

  it("refuses an unexpected account", async () => {
    const { client } = fakeClient([me]);
    const run = await syncAccount({ ...ctxFor(client), expectedUsername: "someone_else" });
    expect(run).toMatchObject({ status: "failed", errorCode: "unexpected_account" });
    expect(await count("account_snapshots")).toBe(0);
  });

  it("records a failed run when there is no token at all", async () => {
    const run = await syncAccount({ db, client: null, trigger: "test" });
    expect(run).toMatchObject({ status: "failed", errorCode: "no_token" });
    expect(await count("account_snapshots")).toBe(0);
  });
});

describe("syncAccountInsights (follower_count = new followers/day)", () => {
  const series = (values: Array<[string, number]>): Route => (u) =>
    u.pathname.endsWith(`/${ACCOUNT}/insights`) && u.searchParams.get("metric") === "follower_count"
      ? { body: { data: [{ name: "follower_count", period: "day", values: values.map(([end_time, value]) => ({ end_time, value })) }] } }
      : undefined;

  it("is idempotent per day and appends only changed days", async () => {
    const first = fakeClient([me, series([["2026-11-13T08:00:00+0000", 12], ["2026-11-14T08:00:00+0000", 0]])]);
    await syncAccount(ctxFor(first.client));
    const r1 = await syncAccountInsights(ctxFor(first.client));
    expect(r1.stats).toMatchObject({ points: 2, inserted: 2, unchanged: 0 });

    const again = fakeClient([me, series([["2026-11-13T08:00:00+0000", 12], ["2026-11-14T08:00:00+0000", 0]])]);
    const r2 = await syncAccountInsights(ctxFor(again.client));
    expect(r2.stats).toMatchObject({ inserted: 0, unchanged: 2 });

    // Meta can revise a day (data delayed up to 48h): the revision is appended, history kept.
    const revised = fakeClient([me, series([["2026-11-14T08:00:00+0000", 4], ["2026-11-15T08:00:00+0000", 7]])]);
    const r3 = await syncAccountInsights(ctxFor(revised.client));
    expect(r3.stats).toMatchObject({ inserted: 2, unchanged: 0 });
    expect(await count("account_insight_observations")).toBe(4);

    const { rows } = await db.query(
      "SELECT value, status FROM account_insight_observations WHERE end_time = '2026-11-14T08:00:00Z' ORDER BY id",
    );
    expect(rows).toEqual([{ value: 0, status: "available" }, { value: 4, status: "available" }]);
  });

  it("does not touch account_snapshots", async () => {
    const f = fakeClient([me, series([["2026-11-13T08:00:00+0000", 12]])]);
    await syncAccount(ctxFor(f.client));
    const before = await count("account_snapshots");
    await syncAccountInsights(ctxFor(f.client));
    expect(await count("account_snapshots")).toBe(before);
  });
});

describe("syncMedia", () => {
  it("pages through all media, parses missing shortcodes from permalinks, and is idempotent", async () => {
    const f = fakeClient([me, mediaList]);
    await syncAccount(ctxFor(f.client));
    const r1 = await syncMedia(ctxFor(f.client));
    expect(r1.status).toBe("succeeded");
    expect(r1.stats).toMatchObject({ pages: 2, mediaSeen: 2, mediaInserted: 2 });
    const r2 = await syncMedia(ctxFor(f.client));
    expect(r2.stats).toMatchObject({ mediaSeen: 2, mediaInserted: 0 });

    const { rows } = await db.query("SELECT ig_media_id, shortcode, shortcode_source, first_seen_sync_run_id, last_seen_sync_run_id FROM media ORDER BY ig_media_id");
    expect(rows).toEqual([
      { ig_media_id: "m-feed", shortcode: "FEEDcode1", shortcode_source: "api", first_seen_sync_run_id: r1.id, last_seen_sync_run_id: r2.id },
      { ig_media_id: "m-reel", shortcode: "REELcode2", shortcode_source: "permalink", first_seen_sync_run_id: r1.id, last_seen_sync_run_id: r2.id },
    ]);

    // node-field counts: comments_count 0 on the post is a real 0; missing on the reel is NULL/unavailable
    const obs = await db.query(
      "SELECT ig_media_id, metric, value, status FROM media_metric_observations WHERE sync_run_id = $1 ORDER BY ig_media_id, metric",
      [r1.id],
    );
    expect(obs.rows).toEqual([
      { ig_media_id: "m-feed", metric: "comments_count", value: 0, status: "available" },
      { ig_media_id: "m-feed", metric: "like_count", value: 5, status: "available" },
      { ig_media_id: "m-reel", metric: "comments_count", value: null, status: "unavailable" },
      { ig_media_id: "m-reel", metric: "like_count", value: 9, status: "available" },
    ]);
  });

  it("falls back to a smaller field set when the API rejects a field", async () => {
    const strict: Route = (u) =>
      u.pathname.endsWith("/media") && (u.searchParams.get("fields") ?? "").includes("shortcode")
        ? graphError(100, "(#100) Tried accessing nonexisting field (shortcode)")
        : undefined;
    const f = fakeClient([me, strict, mediaList]);
    await syncAccount(ctxFor(f.client));
    const r = await syncMedia(ctxFor(f.client));
    expect(r.status).toBe("succeeded");
    expect(r.stats).toMatchObject({ fieldSet: 1, mediaSeen: 2 });
    expect(await count("api_errors")).toBe(1);
  });
});

describe("syncMediaInsights", () => {
  async function setup(insights: Route) {
    const f = fakeClient([me, mediaList, insights]);
    await syncAccount(ctxFor(f.client));
    await syncMedia(ctxFor(f.client));
    return f;
  }

  it("stores Reels follows as 'unsupported' without asking the API, and a real 0 for a post", async () => {
    const insights: Route = (u) => {
      if (!u.pathname.endsWith("/insights")) return undefined;
      const metrics = (u.searchParams.get("metric") ?? "").split(",");
      const vals: Record<string, number> = {};
      for (const m of metrics) vals[m] = m === "follows" ? 0 : 11;
      return insightsBody(vals);
    };
    const f = await setup(insights);
    const run = await syncMediaInsights(ctxFor(f.client));
    expect(run.status).toBe("succeeded");

    const reelCalls = f.calls.filter((c) => c.url.pathname.includes("/m-reel/insights"));
    expect(reelCalls).toHaveLength(1);
    expect(reelCalls[0]!.url.searchParams.get("metric")).not.toMatch(/follows|profile_visits|profile_activity/);

    const { rows } = await db.query(
      "SELECT ig_media_id, value, status, status_reason, source, sync_run_id FROM media_metric_observations WHERE metric = 'follows' ORDER BY ig_media_id",
    );
    expect(rows[0]).toMatchObject({ ig_media_id: "m-feed", value: 0, status: "available", source: "instagram_graph_api", sync_run_id: run.id });
    expect(rows[1]).toMatchObject({ ig_media_id: "m-reel", value: null, status: "unsupported", sync_run_id: run.id });
    expect(rows[1].status_reason).toMatch(/does not provide follows for REELS/);

    const media = await mediaWithLatestMetrics({ db });
    const reel = media.find((m) => m.igMediaId === "m-reel")!;
    const post = media.find((m) => m.igMediaId === "m-feed")!;
    expect(reel.metrics.follows!.status).toBe("unsupported");
    expect(formatMetric(reel.metrics.follows!)).toBe("Unavailable");
    expect(post.metrics.follows).toMatchObject({ status: "available", value: 0 });
    expect(formatMetric(post.metrics.follows!)).toBe("0");
    expect(reel.metrics.reach).toMatchObject({ status: "available", isPlatformEstimated: true });
    expect(reel.metrics.views).toMatchObject({ status: "available", isPlatformEstimated: false });
  });

  it("isolates one unsupported metric: retries per metric, only that metric is 'unsupported'", async () => {
    const insights: Route = (u) => {
      if (!u.pathname.includes("/insights")) return undefined;
      const metrics = (u.searchParams.get("metric") ?? "").split(",");
      if (metrics.includes("saved")) {
        return graphError(100, "(#100) The Media Insights API does not support the saved metric for this media");
      }
      return insightsBody(Object.fromEntries(metrics.map((m) => [m, 3])));
    };
    const f = await setup(insights);
    const run = await syncMediaInsights(ctxFor(f.client), { mediaIds: ["m-reel"] });
    expect(run.status).toBe("succeeded");
    const { rows } = await db.query<{ metric: string; status: string; value: number | null }>(
      "SELECT metric, status, value FROM media_metric_observations WHERE ig_media_id = 'm-reel' AND metric_origin = 'insight' AND sync_run_id = $1",
      [run.id],
    );
    const by = Object.fromEntries(rows.map((r) => [r.metric, r]));
    expect(by.saved).toEqual({ metric: "saved", status: "unsupported", value: null });
    for (const m of ["views", "reach", "likes", "comments", "shares", "total_interactions", "ig_reels_avg_watch_time"]) {
      expect(by[m]).toEqual({ metric: m, status: "available", value: 3 });
    }
    const errs = await db.query("SELECT classification, metric FROM api_errors ORDER BY id");
    expect(errs.rows).toEqual([
      { classification: "unsupported_metric", metric: expect.stringContaining("saved") },
      { classification: "unsupported_metric", metric: "saved" },
    ]);
  });

  it("stores an omitted metric as NULL/'unavailable', never 0", async () => {
    const insights: Route = (u) => (u.pathname.includes("/insights") ? insightsBody({ views: 8 }) : undefined);
    const f = await setup(insights);
    const run = await syncMediaInsights(ctxFor(f.client), { mediaIds: ["m-reel"] });
    const { rows } = await db.query(
      "SELECT value, status FROM media_metric_observations WHERE ig_media_id = 'm-reel' AND metric = 'reach' AND sync_run_id = $1",
      [run.id],
    );
    expect(rows).toEqual([{ value: null, status: "unavailable" }]);
  });

  it("aborts on an auth error without writing observations for that media", async () => {
    const insights: Route = (u) => (u.pathname.includes("/insights") ? graphError(190, "Error validating access token", 400) : undefined);
    const f = await setup(insights);
    const before = await count("media_metric_observations");
    const run = await syncMediaInsights(ctxFor(f.client));
    expect(run).toMatchObject({ status: "failed", errorCode: "ig_190" });
    expect(await count("media_metric_observations")).toBe(before);
  });

  it("is safe to re-run: fresh media are skipped, a new run appends a new snapshot", async () => {
    const insights: Route = (u) => {
      if (!u.pathname.includes("/insights")) return undefined;
      return insightsBody(Object.fromEntries((u.searchParams.get("metric") ?? "").split(",").map((m) => [m, 1])));
    };
    const f = await setup(insights);
    const r1 = await syncMediaInsights(ctxFor(f.client));
    const n1 = await count("media_metric_observations");
    const r2 = await syncMediaInsights(ctxFor(f.client)); // within minIntervalHours -> nothing to do
    expect(r2.stats).toMatchObject({ mediaCandidates: 0 });
    expect(await count("media_metric_observations")).toBe(n1);
    const r3 = await syncMediaInsights(ctxFor(f.client), { minIntervalHours: 0 });
    expect(r3.stats).toMatchObject({ mediaProcessed: 2 });
    expect(await count("media_metric_observations")).toBeGreaterThan(n1);
    // no observation was ever updated in place
    const { rows } = await db.query("SELECT DISTINCT sync_run_id FROM media_metric_observations WHERE metric_origin = 'insight' ORDER BY 1");
    expect(rows.map((r) => r.sync_run_id)).toEqual([r1.id, r3.id]);
  });

  it("shows 'pending' for metrics never fetched", async () => {
    const f = fakeClient([me, mediaList]);
    await syncAccount(ctxFor(f.client));
    await syncMedia(ctxFor(f.client));
    const [first] = await mediaWithLatestMetrics({ db, limit: 1 });
    expect(first!.metrics.views!.status).toBe("pending");
    expect(formatMetric(first!.metrics.views!)).toBe("Unavailable");
  });
});

describe("observation tables are append-only", () => {
  it("rejects UPDATE on media_metric_observations", async () => {
    const f = fakeClient([me, mediaList]);
    await syncAccount(ctxFor(f.client));
    await syncMedia(ctxFor(f.client));
    await expect(db.query("UPDATE media_metric_observations SET value = 1")).rejects.toThrow(/append-only/);
  });
});
