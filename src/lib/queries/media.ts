import { getPinnedAccountId } from "../account/tracked";
import type { Queryable } from "../db";
import { ALL_MEDIA_METRICS, effectiveProductType, MAX_METRIC_VALUE, staticUnsupportedReason } from "../instagram/metrics";
import { available, notAvailable, SOURCES, type AvailabilityStatus, type Provenanced, type Source } from "../provenance";

/** The newest AVAILABLE observation of a metric, shown when the latest observation is not available. */
export interface LastAvailable {
  value: number;
  source: Source;
  retrievedAt: Date;
  syncRunId: number;
}

/**
 * One metric of one media item: the LATEST observation (a Provenanced<number>). When that latest
 * observation is not available, `lastAvailable` carries the most recent available reading, if
 * any, so the UI can say "Unavailable (last recorded 12 on <date>)". It is never set for
 * metrics that are unsupported for the product type.
 */
export type MediaMetric = Provenanced<number> & { lastAvailable?: LastAvailable };

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
  metrics: Record<string, MediaMetric>;
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
  /** numeric as text, parsed per row so one unreadable value cannot fail the whole query */
  value_text: string | null;
  status: AvailabilityStatus;
  is_platform_estimated: boolean;
  source: string;
  retrieved_at: Date;
  sync_run_id: number;
  status_reason: string | null;
}

/** Parse a stored value; null if it is not a finite, non-negative, bounded number. */
function parseStoredValue(text: string | null): number | null {
  if (text === null) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > MAX_METRIC_VALUE) return null;
  return n;
}

// Per-post follows come ONLY from the Instagram API `follows` insight.
const OBS_FILTER = `ig_media_id = ANY($1)
        AND NOT (metric = 'follows' AND (source <> '${SOURCES.instagramGraphApi}' OR metric_origin <> 'insight'))`;
const OBS_COLUMNS = `ig_media_id, metric, value::text AS value_text, status, is_platform_estimated, source,
            retrieved_at, sync_run_id, status_reason`;

function byMediaAndMetric(rows: ObsRow[]): Map<string, Map<string, ObsRow>> {
  const out = new Map<string, Map<string, ObsRow>>();
  for (const r of rows) {
    let m = out.get(r.ig_media_id);
    if (!m) out.set(r.ig_media_id, (m = new Map()));
    m.set(r.metric, r);
  }
  return out;
}

/**
 * Media (newest first) with the LATEST observation of each metric.
 *
 * Per metric, in order of precedence:
 *   1. 'unsupported' if Meta's docs say the metric does not exist for the product type
 *      (e.g. follows / profile_visits / profile_activity on REELS), whatever is stored;
 *   2. the latest observation, whatever its status (a newer 'unavailable' / 'error' is shown as
 *      such, never hidden behind an older number); when it is not available, `lastAvailable`
 *      carries the newest available reading separately;
 *   3. 'pending' if nothing was ever fetched.
 * A stored value that cannot be read back is reported as 'error' for that metric only.
 * Defaults to the pinned tracked account.
 */
export async function mediaWithLatestMetrics(o: {
  db: Queryable;
  igUserId?: string;
  limit?: number;
  offset?: number;
  productType?: string;
}): Promise<MediaWithMetrics[]> {
  const igUserId = o.igUserId ?? (await getPinnedAccountId(o.db));
  if (!igUserId) return [];
  const { rows: media } = await o.db.query<MediaRow>(
    `SELECT ig_media_id, shortcode, shortcode_source, permalink, caption, media_type, media_product_type,
            published_at, thumbnail_url, media_url, first_seen_at, last_seen_at
       FROM media
      WHERE ig_user_id = $1
        AND ($2::text IS NULL OR media_product_type = $2)
      ORDER BY published_at DESC NULLS LAST, ig_media_id
      LIMIT $3 OFFSET $4`,
    [igUserId, o.productType ?? null, o.limit ?? 50, o.offset ?? 0],
  );
  if (media.length === 0) return [];
  const ids = media.map((m) => m.ig_media_id);

  const [latestRes, lastAvailRes] = await Promise.all([
    o.db.query<ObsRow>(
      `SELECT DISTINCT ON (ig_media_id, metric) ${OBS_COLUMNS}
         FROM media_metric_observations
        WHERE ${OBS_FILTER}
        ORDER BY ig_media_id, metric, retrieved_at DESC, id DESC`,
      [ids],
    ),
    o.db.query<ObsRow>(
      `SELECT DISTINCT ON (ig_media_id, metric) ${OBS_COLUMNS}
         FROM media_metric_observations
        WHERE ${OBS_FILTER} AND status = 'available'
        ORDER BY ig_media_id, metric, retrieved_at DESC, id DESC`,
      [ids],
    ),
  ]);
  const latestBy = byMediaAndMetric(latestRes.rows);
  const lastAvailBy = byMediaAndMetric(lastAvailRes.rows);

  return media.map((m) => {
    const latest = latestBy.get(m.ig_media_id) ?? new Map<string, ObsRow>();
    const lastAvail = lastAvailBy.get(m.ig_media_id) ?? new Map<string, ObsRow>();
    const productType = effectiveProductType(m.media_product_type, m.permalink);
    const metrics: Record<string, MediaMetric> = {};
    const names = new Set([...ALL_MEDIA_METRICS, ...latest.keys()]);
    for (const name of names) {
      const row = latest.get(name);
      const unsupported = staticUnsupportedReason(name, productType);
      if (unsupported) {
        metrics[name] = notAvailable("unsupported", unsupported, { source: SOURCES.instagramGraphApi });
        continue;
      }
      if (!row) {
        metrics[name] = notAvailable("pending", "Not fetched yet");
        continue;
      }
      const prov = { source: row.source, retrievedAt: row.retrieved_at, syncRunId: row.sync_run_id };
      if (row.status === "available") {
        const value = parseStoredValue(row.value_text);
        metrics[name] =
          value === null
            ? notAvailable("error", "The stored value could not be read as a valid number", prov)
            : available(value, row.source, row.retrieved_at, { syncRunId: row.sync_run_id, isPlatformEstimated: row.is_platform_estimated });
        continue;
      }
      const result: MediaMetric = notAvailable(row.status, row.status_reason ?? row.status, prov);
      const la = lastAvail.get(name);
      const laValue = la ? parseStoredValue(la.value_text) : null;
      if (la && laValue !== null) {
        result.lastAvailable = { value: laValue, source: la.source, retrievedAt: la.retrieved_at, syncRunId: la.sync_run_id };
      }
      metrics[name] = result;
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
