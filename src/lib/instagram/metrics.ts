/**
 * Media insight metrics per media_product_type.
 *
 * Source: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/
 * (page "Updated: Sep 11, 2026", re-read 2026-11-15). Relevant facts from its Metrics table:
 *   - follows, profile_visits, profile_activity: FEED (posts) and STORY only. NOT REELS.
 *   - views, reach, shares, total_interactions: FEED, REELS, STORY.
 *   - likes, comments, saved: FEED, REELS.
 *   - ig_reels_avg_watch_time, ig_reels_video_view_total_time, reels_skip_rate: REELS only.
 *   - reach and reels_skip_rate are labelled "Metric is estimated" by Meta.
 *   - impressions is deprecated for media created after 2024-07-02; plays is gone. Not requested.
 *   - "If insights data you are requesting does not exist or is currently unavailable, the API
 *      returns an empty data set instead of 0" -> a metric absent from a 200 response is stored
 *      as status 'unavailable' with NULL, never as 0.
 *   - "Insights data is not available for any media within an Instagram Media album" (children).
 *   - Story metrics are only available for 24 hours; values < 5 return error code 10.
 */

import type { InsightValue } from "./client";

export type MediaProductType = "FEED" | "REELS" | "STORY" | "AD";

export interface MetricDefinition {
  name: string;
  /** Product types Meta's docs list this metric for. */
  productTypes: readonly MediaProductType[];
  /** Meta's docs label: "Metric is estimated". */
  platformEstimated: boolean;
  unit: "count" | "milliseconds" | "percent";
}

export const MEDIA_INSIGHT_METRICS: readonly MetricDefinition[] = [
  { name: "views", productTypes: ["FEED", "REELS", "STORY"], platformEstimated: false, unit: "count" },
  { name: "reach", productTypes: ["FEED", "REELS", "STORY"], platformEstimated: true, unit: "count" },
  { name: "likes", productTypes: ["FEED", "REELS"], platformEstimated: false, unit: "count" },
  { name: "comments", productTypes: ["FEED", "REELS"], platformEstimated: false, unit: "count" },
  { name: "shares", productTypes: ["FEED", "REELS", "STORY"], platformEstimated: false, unit: "count" },
  { name: "saved", productTypes: ["FEED", "REELS"], platformEstimated: false, unit: "count" },
  { name: "total_interactions", productTypes: ["FEED", "REELS", "STORY"], platformEstimated: false, unit: "count" },
  { name: "follows", productTypes: ["FEED", "STORY"], platformEstimated: false, unit: "count" },
  { name: "profile_visits", productTypes: ["FEED", "STORY"], platformEstimated: false, unit: "count" },
  { name: "profile_activity", productTypes: ["FEED", "STORY"], platformEstimated: false, unit: "count" },
  // Meta does not state the unit in the reference table; Graph API reports these in milliseconds.
  { name: "ig_reels_avg_watch_time", productTypes: ["REELS"], platformEstimated: false, unit: "milliseconds" },
  { name: "ig_reels_video_view_total_time", productTypes: ["REELS"], platformEstimated: false, unit: "milliseconds" },
  { name: "reels_skip_rate", productTypes: ["REELS"], platformEstimated: true, unit: "percent" },
] as const;

/** Fields on the IG Media node that are counts; stored as observations with metric_origin 'field'. */
export const MEDIA_FIELD_METRICS = ["like_count", "comments_count"] as const;
export type MediaFieldMetric = (typeof MEDIA_FIELD_METRICS)[number];

const BY_NAME = new Map(MEDIA_INSIGHT_METRICS.map((m) => [m.name, m]));

/** Upper bound for any stored metric value (matches the DB CHECK in migration 0002). */
export const MAX_METRIC_VALUE = 1e15;

/** Unit of a metric. Unknown metrics (and every account-level insight) are treated as counts. */
export function metricUnit(name: string): MetricDefinition["unit"] {
  return BY_NAME.get(name)?.unit ?? "count";
}

/**
 * Checks a numeric API value against the metric's unit. Counts must be non-negative safe
 * integers; durations and percentages may be fractional but must be finite, non-negative and
 * bounded (percent <= 100). Anything else becomes `invalid`, which the sync stores as status
 * 'error' with NULL and the reason.
 */
export function validateMetricValue(metric: string, v: InsightValue): InsightValue {
  if (v.kind !== "value") return v;
  const x = v.value;
  const unit = metricUnit(metric);
  const bad = (why: string): InsightValue => ({ kind: "invalid", reason: `API returned ${x} for ${metric}: ${why}` });
  if (!Number.isFinite(x)) return bad("not a finite number");
  if (x < 0) return bad("negative");
  if (x > MAX_METRIC_VALUE) return bad(`above the plausible maximum ${MAX_METRIC_VALUE}`);
  if (unit === "count" && !Number.isSafeInteger(x)) return bad("a count must be a whole number");
  if (unit === "percent" && x > 100) return bad("a percentage above 100");
  return v;
}

/**
 * Metrics Meta documents for FEED/STORY but NOT for REELS. When the product type is unknown the
 * item could be a Reel, so these are never requested (an API answer could not be trusted as a
 * per-post value for a Reel); they are stored as 'unavailable' instead.
 */
const NOT_FOR_REELS = MEDIA_INSIGHT_METRICS.filter((m) => !m.productTypes.includes("REELS")).map((m) => m.name);
export const PRODUCT_TYPE_UNKNOWN_REASON = "product type unknown";

const REEL_PERMALINK = /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:reel|reels)\//;

/**
 * The product type used to decide which metrics exist: the API's media_product_type, or REELS
 * when the API omitted it but the permalink is a /reel/ URL (Instagram serves Reels, and only
 * Reels, under /reel/). This is only ever used to request FEWER metrics, never more.
 */
export function effectiveProductType(apiProductType: string | null | undefined, permalink?: string | null): string | null {
  if (apiProductType) return apiProductType;
  if (permalink && REEL_PERMALINK.test(permalink)) return "REELS";
  return null;
}

export function isPlatformEstimated(name: string): boolean {
  return BY_NAME.get(name)?.platformEstimated ?? false;
}

function normaliseProductType(p: string | null | undefined): MediaProductType | null {
  if (!p) return null;
  const up = p.toUpperCase();
  return up === "FEED" || up === "REELS" || up === "STORY" || up === "AD" ? up : null;
}

export interface MetricPlan {
  /** Metrics to request from the API, as one batch. */
  request: string[];
  /** Metrics known from Meta's docs not to exist for this product type (stored as 'unsupported'). */
  unsupported: Array<{ metric: string; reason: string }>;
  /**
   * Metrics deliberately not requested because the product type is unknown and they do not exist
   * for Reels (follows, profile_visits, profile_activity). Stored as 'unavailable'.
   */
  withheld: Array<{ metric: string; reason: string }>;
  /** True when the product type was unknown: the rest of the catalogue is requested and Meta decides. */
  productTypeUnknown: boolean;
}

/**
 * Which metrics to request for a media item. For a known product type we request only the
 * documented set (one unsupported metric can fail a whole insights request) and record the rest
 * of the catalogue as 'unsupported'. If media_product_type was not returned we cannot know, so we
 * request the remaining metrics individually and let the API's answer decide each status, except
 * the FEED/STORY-only metrics (follows, profile_visits, profile_activity), which are never
 * requested for an item that could be a Reel (see `withheld`).
 */
export function planMediaInsights(productType: string | null | undefined): MetricPlan {
  const pt = normaliseProductType(productType);
  if (!pt || pt === "AD") {
    return {
      request: MEDIA_INSIGHT_METRICS.map((m) => m.name).filter((n) => !NOT_FOR_REELS.includes(n)),
      unsupported: [],
      withheld: NOT_FOR_REELS.map((metric) => ({ metric, reason: PRODUCT_TYPE_UNKNOWN_REASON })),
      productTypeUnknown: true,
    };
  }
  const request: string[] = [];
  const unsupported: MetricPlan["unsupported"] = [];
  for (const m of MEDIA_INSIGHT_METRICS) {
    const reason = staticUnsupportedReason(m.name, pt);
    if (reason) unsupported.push({ metric: m.name, reason });
    else request.push(m.name);
  }
  return { request, unsupported, withheld: [], productTypeUnknown: false };
}

/** Every metric the query layer reports for a media item (insights + node fields). */
export const ALL_MEDIA_METRICS: readonly string[] = [
  ...MEDIA_INSIGHT_METRICS.map((m) => m.name),
  ...MEDIA_FIELD_METRICS,
];

/** Reason text if Meta's docs say `metric` does not exist for `productType`, else null. */
export function staticUnsupportedReason(metric: string, productType: string | null | undefined): string | null {
  const pt = normaliseProductType(productType);
  const def = BY_NAME.get(metric);
  if (!pt || !def) return null;
  if (def.productTypes.includes(pt)) return null;
  return `Instagram API does not provide ${metric} for ${pt} media (Meta docs: ${def.productTypes.join(", ")} only)`;
}
