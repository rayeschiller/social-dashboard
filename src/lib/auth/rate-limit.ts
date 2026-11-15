/**
 * Login attempt limiting, backed by audit_log so it holds across serverless instances. Every
 * attempt is audited (never the password; the client address only as a keyed hash).
 */
import { createHmac } from "node:crypto";
import type { Queryable } from "../db";
import { audit } from "../sync/runs";

export const LOGIN_WINDOW_MINUTES = 15;
export const MAX_FAILURES_PER_CLIENT = 5;
export const MAX_FAILURES_GLOBAL = 50;

export function clientKey(headers: Headers, secret: string): string {
  const raw = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || "unknown";
  return createHmac("sha256", secret).update(`login-client|${raw}`).digest("hex").slice(0, 32);
}

/** Null if another attempt is allowed, else the reason it is not. */
export async function loginBlockedReason(db: Queryable, client: string): Promise<string | null> {
  const { rows } = await db.query<{ per_client: number; total: number }>(
    `SELECT count(*) FILTER (WHERE detail->>'client' = $1)::int AS per_client, count(*)::int AS total
       FROM audit_log
      WHERE action = 'dashboard_login_failed'
        AND occurred_at > now() - make_interval(mins => $2::int)`,
    [client, LOGIN_WINDOW_MINUTES],
  );
  const r = rows[0] ?? { per_client: 0, total: 0 };
  if (r.per_client >= MAX_FAILURES_PER_CLIENT || r.total >= MAX_FAILURES_GLOBAL) {
    return `Too many failed attempts; try again in ${LOGIN_WINDOW_MINUTES} minutes`;
  }
  return null;
}

export async function recordLoginAttempt(db: Queryable, client: string, ok: boolean): Promise<void> {
  await audit(db, "dashboard_login", ok ? "dashboard_login_succeeded" : "dashboard_login_failed", undefined, { client });
}
