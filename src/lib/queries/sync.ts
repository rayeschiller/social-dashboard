import type { Queryable } from "../db";
import type { SyncKind } from "../sync/runs";
import { available, notAvailable, SOURCES, type Available, type Provenanced } from "../provenance";

export interface SyncRunSummary {
  id: number;
  kind: string;
  trigger: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  stats: Record<string, unknown>;
}

interface RunRow {
  id: number;
  kind: string;
  trigger: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  stats: Record<string, unknown>;
}

const RUN_COLUMNS = "id, kind, trigger, status, started_at, finished_at, error_code, error_message, stats";

function toSummary(r: RunRow): SyncRunSummary {
  return {
    id: r.id,
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    stats: r.stats,
  };
}

/** Most recent run with status 'succeeded' (optionally of one kind). */
export async function lastSuccessfulSync(db: Queryable, kind?: SyncKind): Promise<Provenanced<SyncRunSummary>> {
  const { rows } = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM sync_runs
      WHERE status = 'succeeded' AND ($1::text IS NULL OR kind = $1)
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [kind ?? null],
  );
  const r = rows[0];
  if (!r) return notAvailable("unavailable", kind ? `No successful ${kind} sync yet` : "No successful sync yet");
  return available(toSummary(r), SOURCES.appDatabase, r.finished_at ?? r.started_at, { syncRunId: r.id });
}

export interface ApiErrorSummary {
  id: number;
  syncRunId: number | null;
  occurredAt: Date;
  endpoint: string;
  httpStatus: number | null;
  errorCode: number | null;
  classification: string;
  message: string;
  igMediaId: string | null;
  metric: string | null;
}

export interface RecentErrors {
  failedRuns: SyncRunSummary[];
  apiErrors: ApiErrorSummary[];
}

/** Recent failed/partial runs and raw API errors, newest first. */
export async function recentErrors(db: Queryable, limit = 20): Promise<Available<RecentErrors>> {
  const [runs, errs] = await Promise.all([
    db.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM sync_runs WHERE status IN ('failed', 'partial')
        ORDER BY started_at DESC, id DESC LIMIT $1`,
      [limit],
    ),
    db.query<{
      id: number;
      sync_run_id: number | null;
      occurred_at: Date;
      endpoint: string;
      http_status: number | null;
      error_code: number | null;
      classification: string;
      message: string;
      ig_media_id: string | null;
      metric: string | null;
    }>(
      `SELECT id, sync_run_id, occurred_at, endpoint, http_status, error_code, classification, message,
              ig_media_id, metric
         FROM api_errors ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [limit],
    ),
  ]);
  return available(
    {
      failedRuns: runs.rows.map(toSummary),
      apiErrors: errs.rows.map((e) => ({
        id: e.id,
        syncRunId: e.sync_run_id,
        occurredAt: e.occurred_at,
        endpoint: e.endpoint,
        httpStatus: e.http_status,
        errorCode: e.error_code,
        classification: e.classification,
        message: e.message,
        igMediaId: e.ig_media_id,
        metric: e.metric,
      })),
    },
    SOURCES.appDatabase,
    new Date(),
  );
}

const KINDS: SyncKind[] = ["account", "account_insights", "media", "media_insights", "token_refresh"];

export interface SyncStatus {
  kinds: Record<string, { lastRun: SyncRunSummary | null; lastSuccess: Provenanced<SyncRunSummary> }>;
  recentRuns: SyncRunSummary[];
}

export async function syncStatus(db: Queryable): Promise<SyncStatus> {
  const kinds: SyncStatus["kinds"] = {};
  for (const kind of KINDS) {
    const { rows } = await db.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM sync_runs WHERE kind = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
      [kind],
    );
    kinds[kind] = { lastRun: rows[0] ? toSummary(rows[0]) : null, lastSuccess: await lastSuccessfulSync(db, kind) };
  }
  const { rows } = await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 20`);
  return { kinds, recentRuns: rows.map(toSummary) };
}
