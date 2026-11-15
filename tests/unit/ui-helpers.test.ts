import { describe, expect, it } from "vitest";
import { available, formatMetric, notAvailable, type Provenanced } from "../../src/lib/provenance";
import type { MediaWithMetrics } from "../../src/lib/queries/media";
import { averageDailyNet, followConversionPct, followsPer1000Views } from "../../src/ui/derive";
import { runs } from "../../src/ui/chart";
import { formatDurationMs, provenanceText } from "../../src/ui/format";
import { buildPostView, nextSort, parseSort, sortPosts, type PostView } from "../../src/ui/posts";

const T = new Date("2026-11-10T12:00:00Z");
const av = (n: number) => available(n, "instagram_graph_api", T);
const na = (reason = "synthetic missing") => notAvailable("unavailable", reason);

function media(id: string, metrics: Record<string, Provenanced<number>>, extra: Partial<MediaWithMetrics> = {}): MediaWithMetrics {
  return {
    igMediaId: id, shortcode: null, shortcodeSource: null, permalink: null, caption: null, mediaType: "VIDEO",
    mediaProductType: "FEED", publishedAt: null, thumbnailUrl: null, mediaUrl: null, firstSeenAt: T, lastSeenAt: T,
    metrics, ...extra,
  };
}
const ids = (ps: PostView[]) => ps.map((p) => p.media.igMediaId);

describe("rendering 0 versus Unavailable", () => {
  it("renders a real 0 as 0 and anything else as Unavailable", () => {
    expect(formatMetric(av(0))).toBe("0");
    expect(formatMetric(na())).toBe("Unavailable");
    expect(formatMetric(notAvailable("unsupported", "x"))).toBe("Unavailable");
    expect(formatMetric(notAvailable("pending", "x"))).toBe("Unavailable");
    expect(formatMetric(av(1234567))).toBe("1,234,567");
  });
  it("missing metrics on a post stay Unavailable, never 0", () => {
    const p = buildPostView(media("a", {}));
    expect(formatMetric(p.views)).toBe("Unavailable");
    expect(formatMetric(p.followsPer1k)).toBe("Unavailable");
  });
  it("formats durations, with 0 as a real 0 s", () => {
    expect(formatDurationMs(0)).toBe("0 s");
    expect(formatDurationMs(12_300)).toBe("12.3 s");
    expect(formatDurationMs(245_000)).toBe("4 m 05 s");
  });
  it("describes provenance for available and non-available values", () => {
    expect(provenanceText(av(5), "UTC")).toContain("Source: Instagram Graph API");
    expect(provenanceText(na("nope"), "UTC")).toContain("Reason: nope");
  });
});

describe("follows per 1,000 views", () => {
  it("is computed only when both inputs are available", () => {
    expect(followsPer1000Views(av(5), av(1000))).toMatchObject({ status: "available", value: 5 });
    expect(formatMetric(followsPer1000Views(na(), av(1000)))).toBe("Unavailable");
    expect(formatMetric(followsPer1000Views(av(5), na()))).toBe("Unavailable");
    expect(formatMetric(followsPer1000Views(na(), na()))).toBe("Unavailable");
  });
  it("treats 0 follows as a real 0 and 0 views as undefined", () => {
    expect(formatMetric(followsPer1000Views(av(0), av(500)))).toBe("0");
    expect(formatMetric(followsPer1000Views(av(3), av(0)))).toBe("Unavailable");
  });
  it("derives conversion percent under the same rule", () => {
    expect(followConversionPct(av(5), av(1000))).toMatchObject({ status: "available", value: 0.5 });
    expect(formatMetric(followConversionPct(notAvailable("unsupported", "reels"), av(1000)))).toBe("Unavailable");
  });
  it("is Unavailable for a Reel whose follows are unsupported", () => {
    const p = buildPostView(
      media("r", { views: av(900), follows: notAvailable("unsupported", "no follows for reels") }, { mediaProductType: "REELS" }),
    );
    expect(p.isReel).toBe(true);
    expect(formatMetric(p.follows)).toBe("Unavailable");
    expect(formatMetric(p.followsPer1k)).toBe("Unavailable");
  });
});

describe("sorting with unavailable last", () => {
  const posts = [
    buildPostView(media("none", {})),
    buildPostView(media("zero", { views: av(0) })),
    buildPostView(media("big", { views: av(900) })),
    buildPostView(media("small", { views: av(10) })),
    buildPostView(media("err", { views: notAvailable("error", "boom") })),
  ];
  it("descending: values high to low, a real 0 after positives, unavailable last", () => {
    expect(ids(sortPosts(posts, { key: "views", dir: "desc" }))).toEqual(["big", "small", "zero", "none", "err"]);
  });
  it("ascending: a real 0 first, unavailable still last", () => {
    expect(ids(sortPosts(posts, { key: "views", dir: "asc" }))).toEqual(["zero", "small", "big", "none", "err"]);
  });
  it("sorts by publish date with unknown dates last", () => {
    const ps = [
      buildPostView(media("nodate", {})),
      buildPostView(media("old", {}, { publishedAt: new Date("2026-01-01T00:00:00Z") })),
      buildPostView(media("new", {}, { publishedAt: new Date("2026-06-01T00:00:00Z") })),
    ];
    expect(ids(sortPosts(ps, { key: "published", dir: "desc" }))).toEqual(["new", "old", "nodate"]);
  });
  it("sorts the derived follows-per-1,000 column and does not mutate its input", () => {
    const ps = [
      buildPostView(media("a", { views: av(1000), follows: av(1) })),
      buildPostView(media("b", { views: av(1000), follows: av(9) })),
      buildPostView(media("c", { views: av(1000) })),
    ];
    const before = ids(ps);
    expect(ids(sortPosts(ps, { key: "followsPer1k", dir: "desc" }))).toEqual(["b", "a", "c"]);
    expect(ids(ps)).toEqual(before);
  });
});

describe("sort query parameter", () => {
  it("parses valid values and falls back on invalid ones", () => {
    expect(parseSort("views")).toEqual({ key: "views", dir: "desc" });
    expect(parseSort("views:asc")).toEqual({ key: "views", dir: "asc" });
    expect(parseSort("bogus")).toEqual({ key: "published", dir: "desc" });
    expect(parseSort("views:sideways")).toEqual({ key: "published", dir: "desc" });
    expect(parseSort(undefined)).toEqual({ key: "published", dir: "desc" });
    expect(parseSort(["reach", "views"])).toEqual({ key: "reach", dir: "desc" });
  });
  it("toggles direction on the active column", () => {
    expect(nextSort({ key: "views", dir: "desc" }, "views")).toEqual({ key: "views", dir: "asc" });
    expect(nextSort({ key: "views", dir: "asc" }, "reach")).toEqual({ key: "reach", dir: "desc" });
  });
});

describe("chart gaps and pace", () => {
  it("splits runs at gaps so lines are never joined across a missing day", () => {
    expect(runs([1, 2, null, 3, null, null, 4, 5])).toEqual([[0, 1], [3], [6, 7]]);
    expect(runs([null, null])).toEqual([]);
  });
  it("average daily net uses the two real snapshot times", () => {
    const pt = (at: string, followers: number) => ({ snapshotId: 1, followers, retrievedAt: new Date(at), syncRunId: 1 });
    const net = available(
      { delta: 20, start: pt("2026-11-01T00:00:00Z", 100), end: pt("2026-11-05T00:00:00Z", 120), period: "month" as const, windowStart: T, timezone: "UTC", toleranceHours: 48 },
      "derived_from_snapshots",
      T,
    );
    expect(averageDailyNet(net)).toMatchObject({ status: "available", value: 5 });
    expect(formatMetric(averageDailyNet(na()))).toBe("Unavailable");
  });
});
