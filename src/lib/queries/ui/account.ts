/**
 * Read-only lookup of the pinned tracked account and its connection state for the dashboard header. Only reads ig_accounts and
 * oauth_tokens metadata (never token material).
 */
import { getPinnedAccount } from "../../account/tracked";
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
  const pinned = await getPinnedAccount(db);
  if (!pinned) return notAvailable("unavailable", "No tracked Instagram account is pinned yet; connect or sync the account first");
  const { rows } = await db.query<{
    username: string;
    account_type: string | null;
    updated_at: Date;
  }>("SELECT username, account_type, updated_at FROM ig_accounts WHERE ig_user_id = $1", [pinned.igUserId]);
  const row = rows[0];
  if (!row && !pinned.usernameAtPin) {
    return notAvailable("unavailable", "The tracked account has no stored profile row yet");
  }
  const a = {
    ig_user_id: pinned.igUserId,
    username: row?.username ?? pinned.usernameAtPin ?? pinned.igUserId,
    account_type: row?.account_type ?? null,
    updated_at: row?.updated_at ?? pinned.pinnedAt,
  };

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
