import type { Queryable } from "../db";
import { ALL_MEDIA_METRICS, staticUnsupportedReason } from "../instagram/metrics";
import { available, notAvailable, type AvailabilityStatus, type Provenanced } from "../provenance";

export interface MediaWithMetrics {
  igMediaId: string;
  shortcode: string | null;
  shortcodeSource: "api" | "permalink" | null;
  permalink: string | null;
  caption: string | null;
  mediaType: string | null;
  mediaProductType: string | null;
  publishedAt: Date | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** One entry per known metric. Keys: insight names (views, follows, ...) + like_count, comments_count. */
  metrics: Record<string, Provenanced<number>>;
}

interface MediaRow {
  ig_media_id: string;
  shortcode: string | null;
  shortcode_source: "api" | "permalink" | null;
  permalink: string | null;
  caption: string | null;
  media_type: string | null;
  media_product_type: string | null;
  published_at: Date | null;
  thumbnail_url: string | null;
  media_url: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

interface ObsRow {
  ig_media_id: string;
  metric: string;
  value: number | null;
  status: AvailabilityStatus;
  is_platform_estimated: boolean;
  source: string;
  retrieved_at: Date;
  sync_run_id: number;
  status_reason: string | null;
}

/**
 * Media (newest first) with the latest observation of each metric.
 *
 * Per metric, in order of precedence:
 *   1. the latest 'available' observation (any source; the source is on the result),
 *   2. 'unsupported' if Meta's docs say the metric does not exist for the product type
 *      (e.g. follows / profile_visits / profile_activity on REELS),
 *   3. the latest non-available observation (unavailable / unsupported / error),
 *   4. 'pending' if nothing was ever fetched.
 * Rule 1 means a transient error after a good reading shows the good reading with its own
 * retrievedAt rather than hiding it.
 */
export async function mediaWithLatestMetrics(o: {
  db: Queryable;
  igUserId?: string;
  limit?: number;
  offset?: number;
  productType?: string;
}): Promise<MediaWithMetrics[]> {
  const { rows: media } = await o.db.query<MediaRow>(
    `SELECT ig_media_id, shortcode, shortcode_source, permalink, caption, media_type, media_product_type,
            published_at, thumbnail_url, media_url, first_seen_at, last_seen_at
       FROM media
      WHERE ($1::text IS NULL OR ig_user_id = $1)
        AND ($2::text IS NULL OR media_product_type = $2)
      ORDER BY published_at DESC NULLS LAST, ig_media_id
      LIMIT $3 OFFSET $4`,
    [o.igUserId ?? null, o.productType ?? null, o.limit ?? 50, o.offset ?? 0],
  );
  if (media.length === 0) return [];

  const { rows: obs } = await o.db.query<ObsRow>(
    `SELECT DISTINCT ON (ig_media_id, metric)
            ig_media_id, metric, value, status, is_platform_estimated, source, retrieved_at,
            sync_run_id, status_reason
       FROM media_metric_observations
      WHERE ig_media_id = ANY($1)
      ORDER BY ig_media_id, metric, (status = 'available') DESC, retrieved_at DESC, id DESC`,
    [media.map((m) => m.ig_media_id)],
  );
  const byMedia = new Map<string, Map<string, ObsRow>>();
  for (const r of obs) {
    let m = byMedia.get(r.ig_media_id);
    if (!m) byMedia.set(r.ig_media_id, (m = new Map()));
    m.set(r.metric, r);
  }

  return media.map((m) => {
    const latest = byMedia.get(m.ig_media_id) ?? new Map<string, ObsRow>();
    const metrics: Record<string, Provenanced<number>> = {};
    const names = new Set([...ALL_MEDIA_METRICS, ...latest.keys()]);
    for (const name of names) {
      const row = latest.get(name);
      const unsupported = staticUnsupportedReason(name, m.media_product_type);
      if (row && row.status === "available" && row.value !== null) {
        metrics[name] = available(row.value, row.source, row.retrieved_at, {
          syncRunId: row.sync_run_id,
          isPlatformEstimated: row.is_platform_estimated,
        });
      } else if (unsupported) {
        metrics[name] = notAvailable("unsupported", unsupported, {
          source: row?.source ?? "instagram_graph_api",
          retrievedAt: row?.retrieved_at,
          syncRunId: row?.sync_run_id,
        });
      } else if (row) {
        metrics[name] = notAvailable(row.status === "available" ? "error" : row.status, row.status_reason ?? row.status, {
          source: row.source,
          retrievedAt: row.retrieved_at,
          syncRunId: row.sync_run_id,
        });
      } else {
        metrics[name] = notAvailable("pending", "Not fetched yet");
      }
    }
    return {
      igMediaId: m.ig_media_id,
      shortcode: m.shortcode,
      shortcodeSource: m.shortcode_source,
      permalink: m.permalink,
      caption: m.caption,
      mediaType: m.media_type,
      mediaProductType: m.media_product_type,
      publishedAt: m.published_at,
      thumbnailUrl: m.thumbnail_url,
      mediaUrl: m.media_url,
      firstSeenAt: m.first_seen_at,
      lastSeenAt: m.last_seen_at,
      metrics,
    };
  });
}
