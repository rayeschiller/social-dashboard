/**
 * Read-only account/connection lookup for the dashboard header. Only reads ig_accounts and
 * oauth_tokens metadata (never token material).
 */
import type { Queryable } from "../../db";
import { available, notAvailable, SOURCES, type Provenanced } from "../../provenance";

export type ConnectionState = "connected" | "no_stored_token" | "token_expired";

export interface AccountInfo {
  igUserId: string;
  username: string;
  accountType: string | null;
  connection: ConnectionState;
  tokenExpiresAt: Date | null;
}

export async function getAccountInfo(db: Queryable, now: Date = new Date()): Promise<Provenanced<AccountInfo>> {
  const { rows } = await db.query<{
    ig_user_id: string;
    username: string;
    account_type: string | null;
    updated_at: Date;
  }>("SELECT ig_user_id, username, account_type, updated_at FROM ig_accounts ORDER BY updated_at DESC LIMIT 1");
  const a = rows[0];
  if (!a) return notAvailable("unavailable", "No Instagram account has been connected or synced yet");

  const { rows: tokens } = await db.query<{ expires_at: Date | null }>(
    `SELECT expires_at FROM oauth_tokens
      WHERE ig_user_id = $1 AND superseded_at IS NULL AND revoked_at IS NULL
      ORDER BY issued_at DESC LIMIT 1`,
    [a.ig_user_id],
  );
  const t = tokens[0];
  let connection: ConnectionState = "no_stored_token";
  if (t) connection = t.expires_at && t.expires_at.getTime() <= now.getTime() ? "token_expired" : "connected";
  return available(
    {
      igUserId: a.ig_user_id,
      username: a.username,
      accountType: a.account_type,
      connection,
      tokenExpiresAt: t?.expires_at ?? null,
    },
    SOURCES.appDatabase,
    a.updated_at,
  );
}
