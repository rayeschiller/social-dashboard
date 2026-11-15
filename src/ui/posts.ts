/**
 * Post table view-model and server-side sorting. Unavailable values always sort last.
 * Sorting and derived ratios read only the latest observation; `lastAvailable` is display-only.
 */
import { isAvailable, notAvailable, type Provenanced } from "../lib/provenance";
import type { MediaMetric, MediaWithMetrics } from "../lib/queries/media";
import { followConversionPct, followsPer1000Views } from "./derive";

export const SORT_KEYS = [
  "published",
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "avgWatch",
  "totalWatch",
  "follows",
  "followsPer1k",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";
export interface SortSpec {
  key: SortKey;
  dir: SortDir;
}
export const DEFAULT_SORT: SortSpec = { key: "published", dir: "desc" };

/** `?sort=views` (descending) or `?sort=views:asc`. Anything invalid falls back to the default. */
export function parseSort(raw: string | string[] | undefined): SortSpec {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return DEFAULT_SORT;
  const [key, dir] = v.split(":");
  if (!(SORT_KEYS as readonly string[]).includes(key ?? "")) return DEFAULT_SORT;
  if (dir !== undefined && dir !== "asc" && dir !== "desc") return DEFAULT_SORT;
  return { key: key as SortKey, dir: dir ?? "desc" };
}

export function sortParam(spec: SortSpec): string {
  return spec.dir === "desc" ? spec.key : `${spec.key}:asc`;
}

/** The sort to request when a column header is clicked. */
export function nextSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key === key) return { key, dir: current.dir === "desc" ? "asc" : "desc" };
  return { key, dir: "desc" };
}

export interface PostView {
  media: MediaWithMetrics;
  isReel: boolean;
  publishedMs: number | null;
  views: MediaMetric;
  reach: MediaMetric;
  likes: MediaMetric;
  comments: MediaMetric;
  shares: MediaMetric;
  saves: MediaMetric;
  avgWatch: MediaMetric;
  totalWatch: MediaMetric;
  follows: MediaMetric;
  followsPer1k: Provenanced<number>;
  conversionPct: Provenanced<number>;
}

const MISSING = (name: string) => notAvailable("pending", `${name} has not been fetched`);

function pick(m: MediaWithMetrics, ...names: string[]): MediaMetric {
  const found = names.map((n) => m.metrics[n]).filter((x): x is MediaMetric => x !== undefined);
  return found.find(isAvailable) ?? found[0] ?? MISSING(names[0] ?? "metric");
}

export function buildPostView(m: MediaWithMetrics): PostView {
  const views = pick(m, "views");
  const follows = pick(m, "follows");
  return {
    media: m,
    isReel: m.mediaProductType === "REELS",
    publishedMs: m.publishedAt ? m.publishedAt.getTime() : null,
    views,
    reach: pick(m, "reach"),
    likes: pick(m, "likes", "like_count"),
    comments: pick(m, "comments", "comments_count"),
    shares: pick(m, "shares"),
    saves: pick(m, "saved"),
    avgWatch: pick(m, "ig_reels_avg_watch_time"),
    totalWatch: pick(m, "ig_reels_video_view_total_time"),
    follows,
    followsPer1k: followsPer1000Views(follows, views),
    conversionPct: followConversionPct(follows, views),
  };
}

export function sortValue(p: PostView, key: SortKey): number | null {
  if (key === "published") return p.publishedMs;
  const cell = p[key];
  return isAvailable(cell) ? cell.value : null;
}

/** Stable sort; null (unavailable) always last whatever the direction. A real 0 is a real value. */
export function sortPosts(posts: readonly PostView[], spec: SortSpec): PostView[] {
  const sign = spec.dir === "asc" ? 1 : -1;
  return [...posts]
    .map((p, i) => ({ p, i, v: sortValue(p, spec.key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return a.v === b.v ? a.i - b.i : sign * (a.v - b.v);
    })
    .map((x) => x.p);
}
