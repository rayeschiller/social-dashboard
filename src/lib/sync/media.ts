/**
 * Media sync.
 *
 * syncMedia: pages through ALL of GET /<IG_ID>/media on every run (Meta returns at most the 10K
 *   most recent), so the first run is the historical backfill. Media rows are upserted
 *   (descriptive metadata only). like_count / comments_count node fields are appended as
 *   observations with metric_origin 'field'.
 *
 * syncMediaInsights: for each media item, requests the documented metric set for its
 *   media_product_type in one call. If that call fails for a reason that could be one bad metric,
 *   each metric is retried on its own so one unsupported metric yields 'unsupported' for that
 *   metric only. Metrics Meta's docs say do not exist for the product type (e.g. follows on REELS)
 *   are recorded as 'unsupported' without calling the API. Values are never derived.
 */
import type pg from "pg";
import { withTransaction } from "../db";
import type { IgMediaNode, InsightValue, InstagramClient } from "../instagram/client";
import { InstagramApiError, statusForClassification } from "../instagram/errors";
import { verifyClientAccount } from "../account/tracked";
import {
  effectiveProductType,
  isPlatformEstimated,
  MAX_METRIC_VALUE,
  MEDIA_FIELD_METRICS,
  planMediaInsights,
  validateMetricValue,
} from "../instagram/metrics";
import { SOURCES, type AvailabilityStatus } from "../provenance";
import { redact } from "../redact";
import { nowFn, recordApiError, runJob, type SyncContext, type SyncRunResult } from "./runs";

/** Field sets tried in order; later sets drop fields Meta documents as Facebook-Login-only. */
export const MEDIA_FIELD_SETS: readonly (readonly string[])[] = [
  [
    "id",
    "caption",
    "media_type",
    "media_product_type",
    "permalink",
    "shortcode",
    "thumbnail_url",
    "media_url",
    "timestamp",
    "like_count",
    "comments_count",
  ],
  // The IG Media reference marks caption and media_product_type "Available for Instagram API with
  // Facebook Login only". If the full set is rejected with an invalid-field error (code 100) before
  // any page is read, retry with progressively smaller sets. Without media_product_type every
  // insight metric is then requested individually and the API decides each status.
  ["id", "media_type", "permalink", "thumbnail_url", "media_url", "timestamp", "like_count", "comments_count", "caption"],
  ["id", "media_type", "permalink", "thumbnail_url", "timestamp"],
];

const SHORTCODE_FROM_PERMALINK = /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;

export function shortcodeFromPermalink(permalink: string | null | undefined): string | null {
  if (!permalink) return null;
  return SHORTCODE_FROM_PERMALINK.exec(permalink)?.[1] ?? null;
}

function parseTimestamp(ts: string | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d;
}

interface Observation {
  igMediaId: string;
  metric: string;
  origin: "insight" | "field";
  value: number | null;
  status: AvailabilityStatus;
  reason: string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
  apiErrorId?: number | null;
  retrievedAt: Date;
}

async function insertObservations(db: pg.PoolClient, runId: number, obs: Observation[]): Promise<number> {
  let n = 0;
  for (const o of obs) {
    if ((o.status === "available") !== (o.value !== null)) {
      throw new Error(`invariant violated for ${o.igMediaId}/${o.metric}: status ${o.status} with value ${o.value}`);
    }
    const res = await db.query(
      `INSERT INTO media_metric_observations
         (ig_media_id, metric, metric_origin, value, status, is_platform_estimated, source,
          retrieved_at, sync_run_id, status_reason, error_code, error_message, api_error_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ig_media_id, metric, sync_run_id) DO NOTHING`,
      [
        o.igMediaId,
        o.metric,
        o.origin,
        o.value,
        o.status,
        o.origin === "insight" ? isPlatformEstimated(o.metric) : false,
        SOURCES.instagramGraphApi,
        o.retrievedAt,
        runId,
        o.reason,
        o.errorCode ?? null,
        o.errorMessage ? redact(o.errorMessage) : null,
        o.apiErrorId ?? null,
      ],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

function fieldObservation(m: IgMediaNode, field: (typeof MEDIA_FIELD_METRICS)[number], requested: boolean, at: Date): Observation {
  const raw = (m as unknown as Record<string, unknown>)[field];
  if (!requested) {
    return { igMediaId: m.id, metric: field, origin: "field", value: null, status: "unavailable", reason: `${field} was not requested (field set fallback)`, retrievedAt: at };
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_METRIC_VALUE) {
    return { igMediaId: m.id, metric: field, origin: "field", value: raw, status: "available", reason: null, retrievedAt: at };
  }
  if (typeof raw === "number") {
    return { igMediaId: m.id, metric: field, origin: "field", value: null, status: "error", reason: `${field} was ${raw}, not a non-negative whole number`, retrievedAt: at };
  }
  if (raw === undefined || raw === null) {
    return {
      igMediaId: m.id,
      metric: field,
      origin: "field",
      value: null,
      status: "unavailable",
      reason: `${field} was not returned (Meta omits it e.g. when the owner hides counts)`,
      retrievedAt: at,
    };
  }
  return { igMediaId: m.id, metric: field, origin: "field", value: null, status: "error", reason: `${field} had unexpected type ${typeof raw}`, retrievedAt: at };
}

async function upsertMedia(tx: pg.PoolClient, igUserId: string, m: IgMediaNode, runId: number, at: Date): Promise<boolean> {
  const apiShortcode = typeof m.shortcode === "string" && m.shortcode ? m.shortcode : null;
  const parsed = apiShortcode ? null : shortcodeFromPermalink(m.permalink);
  const shortcode = apiShortcode ?? parsed;
  const shortcodeSource = apiShortcode ? "api" : parsed ? "permalink" : null;
  const res = await tx.query<{ inserted: boolean }>(
    `INSERT INTO media
       (ig_media_id, ig_user_id, shortcode, shortcode_source, permalink, caption, media_type,
        media_product_type, published_at, thumbnail_url, media_url, first_seen_at, last_seen_at,
        first_seen_sync_run_id, last_seen_sync_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$13)
     ON CONFLICT (ig_media_id) DO UPDATE SET
       shortcode          = COALESCE(EXCLUDED.shortcode, media.shortcode),
       shortcode_source   = CASE WHEN EXCLUDED.shortcode IS NOT NULL THEN EXCLUDED.shortcode_source
                                 ELSE media.shortcode_source END,
       permalink          = COALESCE(EXCLUDED.permalink, media.permalink),
       caption            = COALESCE(EXCLUDED.caption, media.caption),
       media_type         = COALESCE(EXCLUDED.media_type, media.media_type),
       media_product_type = COALESCE(EXCLUDED.media_product_type, media.media_product_type),
       published_at       = COALESCE(EXCLUDED.published_at, media.published_at),
       thumbnail_url      = EXCLUDED.thumbnail_url,
       media_url          = EXCLUDED.media_url,
       last_seen_at       = EXCLUDED.last_seen_at,
       last_seen_sync_run_id = EXCLUDED.last_seen_sync_run_id,
       updated_at         = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      m.id,
      igUserId,
      shortcode,
      shortcodeSource,
      m.permalink ?? null,
      m.caption ?? null,
      m.media_type ?? null,
      m.media_product_type ?? null,
      parseTimestamp(m.timestamp),
      m.thumbnail_url ?? null,
      m.media_url ?? null,
      at,
      runId,
    ],
  );
  return res.rows[0]?.inserted === true;
}

export async function syncMedia(ctx: SyncContext, opts: { pageSize?: number } = {}): Promise<SyncRunResult> {
  const now = nowFn(ctx);
  return runJob(ctx, "media", async (runId, client) => {
    const igUserId = await verifyClientAccount(ctx.db, client);

    const stats = { pages: 0, mediaSeen: 0, mediaInserted: 0, observations: 0, fieldSet: 0, apiRequests: 0 };
    let fieldSetIndex = 0;
    for (;;) {
      const fields = MEDIA_FIELD_SETS[fieldSetIndex]!;
      try {
        for await (const page of client.iterateMedia(igUserId, fields, opts.pageSize)) {
          stats.pages++;
          const at = now();
          await withTransaction(ctx.db, async (tx) => {
            for (const m of page) {
              stats.mediaSeen++;
              if (await upsertMedia(tx, igUserId, m, runId, at)) stats.mediaInserted++;
              const obs = MEDIA_FIELD_METRICS.map((f) => fieldObservation(m, f, fields.includes(f), at));
              stats.observations += await insertObservations(tx, runId, obs);
            }
          });
        }
        break;
      } catch (err) {
        // Only fall back to a smaller field set if nothing was read yet and the API rejected a field.
        const canFallBack =
          err instanceof InstagramApiError &&
          err.classification === "invalid_request" &&
          stats.pages === 0 &&
          fieldSetIndex < MEDIA_FIELD_SETS.length - 1;
        if (!canFallBack) {
          Object.assign(err as object, { stats: { ...stats, apiRequests: client.requestCount } });
          throw err;
        }
        await recordApiError(ctx.db, runId, err as InstagramApiError);
        fieldSetIndex++;
      }
    }
    stats.fieldSet = fieldSetIndex;
    stats.apiRequests = client.requestCount;
    return { igUserId, stats };
  });
}

// -------------------------------------------------------------------------------------------------
// Media insights
// -------------------------------------------------------------------------------------------------

export interface MediaInsightsOptions {
  /** Skip media whose newest insight observation is younger than this (default 6h). */
  minIntervalHours?: number;
  /** Restrict to these media IDs. */
  mediaIds?: string[];
  /** Max media per run (default: all). */
  limit?: number;
}

interface MediaRow {
  ig_media_id: string;
  media_product_type: string | null;
  permalink?: string | null;
}

/** Classifications where isolating metrics one by one can help. */
const ISOLATE_ON = new Set(["unsupported_metric", "invalid_request", "insufficient_data", "unknown"]);

function fromInsight(mediaId: string, metric: string, raw: InsightValue, at: Date): Observation {
  const v = validateMetricValue(metric, raw);
  if (v.kind === "value") {
    return { igMediaId: mediaId, metric, origin: "insight", value: v.value, status: "available", reason: null, retrievedAt: at };
  }
  return {
    igMediaId: mediaId,
    metric,
    origin: "insight",
    value: null,
    status: v.kind === "absent" ? "unavailable" : "error",
    reason: v.reason,
    retrievedAt: at,
  };
}

function fromError(mediaId: string, metric: string, err: InstagramApiError, apiErrorId: number | null, at: Date): Observation {
  return {
    igMediaId: mediaId,
    metric,
    origin: "insight",
    value: null,
    status: statusForClassification(err.classification),
    reason: `${err.classification}: ${err.message}`,
    errorCode: err.code,
    errorMessage: err.message,
    apiErrorId,
    retrievedAt: at,
  };
}

/** Fetch insights for one media item; returns the observations to store. Rethrows run-fatal errors. */
export async function fetchMediaInsightObservations(
  ctx: SyncContext,
  client: InstagramClient,
  runId: number,
  media: MediaRow,
  now: () => Date,
): Promise<Observation[]> {
  const plan = planMediaInsights(effectiveProductType(media.media_product_type, media.permalink));
  const obs: Observation[] = [
    ...plan.unsupported.map((u) => ({
      igMediaId: media.ig_media_id,
      metric: u.metric,
      origin: "insight" as const,
      value: null,
      status: "unsupported" as const,
      reason: media.media_product_type ? u.reason : `${u.reason} (product type taken from the /reel/ permalink)`,
      retrievedAt: now(),
    })),
    ...plan.withheld.map((u) => ({
      igMediaId: media.ig_media_id,
      metric: u.metric,
      origin: "insight" as const,
      value: null,
      status: "unavailable" as const,
      reason: u.reason,
      retrievedAt: now(),
    })),
  ];
  if (plan.request.length === 0) return obs;

  // Unknown product type: the union would certainly fail as a batch, go straight to per-metric.
  if (!plan.productTypeUnknown) {
    try {
      const values = await client.getMediaInsights(media.ig_media_id, plan.request);
      const at = now();
      for (const metric of plan.request) obs.push(fromInsight(media.ig_media_id, metric, values.get(metric)!, at));
      return obs;
    } catch (err) {
      if (!(err instanceof InstagramApiError) || err.fatalForRun) throw err;
      const apiErrorId = await recordApiError(ctx.db, runId, err, { igMediaId: media.ig_media_id, metric: plan.request.join(",") });
      if (!ISOLATE_ON.has(err.classification)) {
        const at = now();
        for (const metric of plan.request) obs.push(fromError(media.ig_media_id, metric, err, apiErrorId, at));
        return obs;
      }
    }
  }

  for (const metric of plan.request) {
    try {
      const values = await client.getMediaInsights(media.ig_media_id, [metric]);
      obs.push(fromInsight(media.ig_media_id, metric, values.get(metric)!, now()));
    } catch (err) {
      if (!(err instanceof InstagramApiError) || err.fatalForRun) throw err;
      const apiErrorId = await recordApiError(ctx.db, runId, err, { igMediaId: media.ig_media_id, metric });
      obs.push(fromError(media.ig_media_id, metric, err, apiErrorId, now()));
    }
  }
  return obs;
}

export async function syncMediaInsights(ctx: SyncContext, opts: MediaInsightsOptions = {}): Promise<SyncRunResult> {
  const now = nowFn(ctx);
  const minIntervalHours = opts.minIntervalHours ?? 6;
  return runJob(ctx, "media_insights", async (runId, client) => {
    const igUserId = await verifyClientAccount(ctx.db, client);

    const { rows: media } = await ctx.db.query<MediaRow>(
      `SELECT m.ig_media_id, m.media_product_type, m.permalink
         FROM media m
        WHERE m.ig_user_id = $1
          AND ($2::text[] IS NULL OR m.ig_media_id = ANY($2))
          AND NOT EXISTS (
            SELECT 1 FROM media_metric_observations o
             WHERE o.ig_media_id = m.ig_media_id AND o.metric_origin = 'insight'
               AND o.retrieved_at > $3::timestamptz - make_interval(secs => $4::double precision * 3600)
          )
        ORDER BY m.published_at DESC NULLS LAST, m.ig_media_id
        LIMIT $5`,
      [igUserId, opts.mediaIds ?? null, now(), minIntervalHours, opts.limit ?? null],
    );

    const stats = {
      mediaCandidates: media.length,
      mediaProcessed: 0,
      observations: 0,
      byStatus: {} as Record<string, number>,
      apiRequests: 0,
    };
    let mediaWithErrors = 0;
    for (const m of media) {
      let obs: Observation[];
      try {
        obs = await fetchMediaInsightObservations(ctx, client, runId, m, now);
      } catch (err) {
        stats.apiRequests = client.requestCount;
        Object.assign(err as object, { stats });
        throw err;
      }
      await withTransaction(ctx.db, async (tx) => {
        stats.observations += await insertObservations(tx, runId, obs);
      });
      stats.mediaProcessed++;
      if (obs.some((o) => o.status === "error")) mediaWithErrors++;
      for (const o of obs) stats.byStatus[o.status] = (stats.byStatus[o.status] ?? 0) + 1;
    }
    stats.apiRequests = client.requestCount;
    return {
      igUserId,
      stats,
      status: mediaWithErrors > 0 ? "partial" : "succeeded",
      note:
        mediaWithErrors > 0
          ? { code: "metric_errors", message: `${mediaWithErrors} media item(s) had metric errors; see api_errors` }
          : undefined,
    };
  });
}
