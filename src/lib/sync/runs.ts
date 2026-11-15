import type pg from "pg";
import type { Queryable } from "../db";
import type { InstagramClient } from "../instagram/client";
import { InstagramApiError, NoTokenError } from "../instagram/errors";
import { redact } from "../redact";

export type SyncKind = "account" | "account_insights" | "media" | "media_insights" | "token_refresh";
export type SyncTrigger = "cron" | "cli" | "oauth" | "manual" | "test";
export type SyncRunStatus = "succeeded" | "partial" | "failed" | "skipped";

export interface SyncContext {
  db: pg.Pool;
  /** null when no credential could be resolved; every job then records a failed run. */
  client: InstagramClient | null;
  /** Why `client` is null (e.g. a NoTokenError). */
  clientError?: Error;
  trigger: SyncTrigger;
  now?: () => Date;
  /**
   * Username the account must have to be pinned on the first account sync (IG_EXPECTED_USERNAME).
   * The entry points (createSyncContext) refuse to run without it; once an account is pinned only
   * its stable id is compared, whatever is set here.
   */
  expectedUsername?: string;
  /** Stable id the account must have to be pinned (IG_EXPECTED_USER_ID). */
  expectedUserId?: string;
}

/** A run still 'running' after this long is dead (crashed / killed); the next run of its kind marks it failed. */
export const STALE_RUN_TIMEOUT_MINUTES = 30;

export interface JobOutcome {
  status?: Exclude<SyncRunStatus, "failed">;
  igUserId?: string | null;
  stats?: Record<string, unknown>;
  /** For partial / skipped runs: a short explanation. */
  note?: { code: string; message: string; detail?: Record<string, unknown> };
}

export interface SyncRunResult {
  id: number;
  kind: SyncKind;
  status: SyncRunStatus;
  stats: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export class SyncAbort extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SyncAbort";
  }
}

export function nowFn(ctx: SyncContext): () => Date {
  return ctx.now ?? (() => new Date());
}

export async function recordApiError(
  db: Queryable,
  runId: number | null,
  err: InstagramApiError,
  extra: { igMediaId?: string; metric?: string } = {},
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO api_errors
       (sync_run_id, endpoint, http_status, error_code, error_subcode, error_type, classification,
        message, fbtrace_id, ig_media_id, metric, attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      runId,
      redact(err.endpoint),
      err.httpStatus,
      err.code,
      err.subcode,
      err.type,
      err.classification,
      redact(err.message),
      err.fbtraceId,
      extra.igMediaId ?? null,
      extra.metric ?? null,
      err.attempts,
    ],
  );
  return rows[0]!.id;
}

export async function audit(
  db: Queryable,
  actor: string,
  action: string,
  entity?: { type: string; id: string },
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4,$5)`,
    [actor, action, entity?.type ?? null, entity?.id ?? null, JSON.stringify(detail)],
  );
}

/**
 * Runs one job as one sync_runs row: inserts it as 'running', holds a per-kind advisory lock so
 * two runs of the same kind never overlap, and always finishes the row with a terminal status.
 * API failures are written to api_errors and summarised on the run.
 */
export async function runJob(
  ctx: SyncContext,
  kind: SyncKind,
  fn: (runId: number, client: InstagramClient) => Promise<JobOutcome>,
  opts: { requiresClient?: boolean } = {},
): Promise<SyncRunResult> {
  const { db } = ctx;
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO sync_runs (kind, trigger, auth_mode) VALUES ($1, $2, $3) RETURNING id`,
    [kind, ctx.trigger, ctx.client?.authMode ?? null],
  );
  const runId = rows[0]!.id;

  const lockClient = await db.connect();
  let locked = false;
  try {
    const lock = await lockClient.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
      [`social-dashboard:sync:${kind}`],
    );
    locked = lock.rows[0]?.ok === true;
    if (!locked) {
      return await finishRun(db, runId, kind, "skipped", {}, {
        code: "already_running",
        message: `another ${kind} sync is in progress`,
      });
    }

    await failStaleRuns(db, kind, runId);

    const configError = ctx.clientError && (ctx.clientError as { code?: unknown }).code;
    if (configError === "config_error" || configError === "unexpected_account") {
      return await finishRun(db, runId, kind, "failed", {}, { code: configError, message: redact(ctx.clientError!.message) });
    }
    if (!ctx.client && opts.requiresClient !== false) {
      const e = ctx.clientError ?? new NoTokenError();
      return await finishRun(db, runId, kind, "failed", {}, { code: "no_token", message: redact(e.message) });
    }

    const outcome = await fn(runId, ctx.client as InstagramClient);
    if (outcome.igUserId) {
      await db.query("UPDATE sync_runs SET ig_user_id = $2 WHERE id = $1", [runId, outcome.igUserId]);
    }
    return await finishRun(db, runId, kind, outcome.status ?? "succeeded", outcome.stats ?? {}, outcome.note);
  } catch (err) {
    const stats = (err as { stats?: Record<string, unknown> }).stats ?? {};
    if (err instanceof InstagramApiError) {
      const apiErrorId = await recordApiError(db, runId, err).catch(() => null);
      return await finishRun(db, runId, kind, "failed", stats, {
        code: err.code !== null ? `ig_${err.code}` : err.classification,
        message: err.message,
        detail: {
          classification: err.classification,
          httpStatus: err.httpStatus,
          code: err.code,
          subcode: err.subcode,
          type: err.type,
          fbtraceId: err.fbtraceId,
          endpoint: err.endpoint,
          apiErrorId,
        },
      });
    }
    if (err instanceof SyncAbort) {
      return await finishRun(db, runId, kind, "failed", stats, { code: err.code, message: err.message, detail: err.detail });
    }
    if (err instanceof NoTokenError) {
      return await finishRun(db, runId, kind, "failed", stats, { code: "no_token", message: redact(err.message) });
    }
    return await finishRun(db, runId, kind, "failed", stats, {
      code: "internal_error",
      message: redact((err as Error)?.message ?? String(err)),
    });
  } finally {
    if (locked) {
      await lockClient
        .query("SELECT pg_advisory_unlock(hashtext($1))", [`social-dashboard:sync:${kind}`])
        .catch(() => undefined);
    }
    lockClient.release();
  }
}

/**
 * Marks runs of `kind` that have been 'running' for longer than the timeout as failed ("timed
 * out"). Called while holding the per-kind lock, so no live run of this kind can be affected.
 */
export async function failStaleRuns(
  db: Queryable,
  kind: SyncKind,
  excludeRunId: number,
  timeoutMinutes = STALE_RUN_TIMEOUT_MINUTES,
): Promise<number> {
  const res = await db.query(
    `UPDATE sync_runs
        SET status = 'failed', finished_at = now(), error_code = 'timed_out', error_message = 'timed out',
            error_detail = jsonb_build_object('timeoutMinutes', $3::int, 'markedByRunId', $2::bigint)
      WHERE kind = $1 AND status = 'running' AND id <> $2
        AND started_at < now() - make_interval(mins => $3::int)`,
    [kind, excludeRunId, timeoutMinutes],
  );
  return res.rowCount ?? 0;
}

async function finishRun(
  db: Queryable,
  runId: number,
  kind: SyncKind,
  status: SyncRunStatus,
  stats: Record<string, unknown>,
  note?: { code: string; message: string; detail?: Record<string, unknown> },
): Promise<SyncRunResult> {
  await db.query(
    `UPDATE sync_runs
        SET status = $2, finished_at = now(), stats = $3,
            error_code = $4, error_message = $5, error_detail = $6
      WHERE id = $1`,
    [
      runId,
      status,
      JSON.stringify(stats),
      note?.code ?? null,
      note ? redact(note.message) : null,
      note?.detail ? JSON.stringify(note.detail) : null,
    ],
  );
  return { id: runId, kind, status, stats, errorCode: note?.code, errorMessage: note?.message };
}
