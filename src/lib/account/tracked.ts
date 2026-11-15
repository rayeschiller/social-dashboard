/**
 * The single Instagram account this dashboard tracks.
 *
 * The account is pinned by its STABLE IG user id (GET /me `user_id`) in the single-row
 * `tracked_account` table: on the first successful account sync or OAuth connect whose username
 * matches IG_EXPECTED_USERNAME (and whose id matches IG_EXPECTED_USER_ID when that is set), or
 * up front from IG_EXPECTED_USER_ID. After that only the id is compared (a renamed account keeps
 * working; a different account with the expected username is refused). A token that belongs to
 * any other id is refused: nothing is stored, and the refusal is written to audit_log and to a
 * failed sync run.
 *
 * Every query and sync job reads the pinned id; nothing picks "the most recently updated
 * ig_accounts row" any more. The pin is immutable (triggers reject UPDATE/DELETE/TRUNCATE).
 * Re-pinning to a different account is a deliberate operator action with the migration-owner
 * role (see README "Changing the tracked account").
 */
import type { InstagramConfig } from "../config";
import type { Queryable } from "../db";
import type { IgMe, InstagramClient } from "../instagram/client";
import { audit, SyncAbort } from "../sync/runs";

export type PinnedVia = "account_sync" | "oauth_connect" | "env";

export interface PinnedAccount {
  igUserId: string;
  usernameAtPin: string | null;
  pinnedVia: PinnedVia;
  pinnedAt: Date;
}

export interface AccountIdentity {
  igUserId: string;
  username: string | null;
}

export interface AccountExpectations {
  expectedUsername?: string;
  expectedUserId?: string;
}

/** A token (or env pin) for an account other than the tracked one. Nothing may be stored. */
export class AccountMismatchError extends Error {
  readonly code = "unexpected_account";
  constructor(
    message: string,
    readonly identity: AccountIdentity,
    readonly pinnedIgUserId: string | null,
  ) {
    super(message);
    this.name = "AccountMismatchError";
  }
}

export async function getPinnedAccount(db: Queryable): Promise<PinnedAccount | null> {
  const { rows } = await db.query<{ ig_user_id: string; username_at_pin: string | null; pinned_via: PinnedVia; pinned_at: Date }>(
    "SELECT ig_user_id, username_at_pin, pinned_via, pinned_at FROM tracked_account LIMIT 1",
  );
  const r = rows[0];
  return r ? { igUserId: r.ig_user_id, usernameAtPin: r.username_at_pin, pinnedVia: r.pinned_via, pinnedAt: r.pinned_at } : null;
}

/** The tracked account's stable id, or null if nothing has been pinned yet. */
export async function getPinnedAccountId(db: Queryable): Promise<string | null> {
  return (await getPinnedAccount(db))?.igUserId ?? null;
}

/** The stable account id from a GET /me response (`user_id`, falling back to `id`). */
export function meAccountId(me: IgMe): string | null {
  const raw: unknown = me.user_id ?? me.id;
  if (typeof raw === "string" && raw) return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  return null;
}

/**
 * Why `who` may not be used, or null if it may. Once pinned only the stable id counts; before
 * that the configured expectations decide.
 */
export function refusalReason(pinned: string | null, who: AccountIdentity, expect: AccountExpectations): string | null {
  const label = `@${who.username ?? "?"} (id ${who.igUserId})`;
  if (pinned) {
    return pinned === who.igUserId ? null : `token belongs to ${label}, but this dashboard tracks id ${pinned}; nothing was stored`;
  }
  if (expect.expectedUserId && expect.expectedUserId !== who.igUserId) {
    return `token belongs to ${label}, expected id ${expect.expectedUserId} (IG_EXPECTED_USER_ID); nothing was stored`;
  }
  if (expect.expectedUsername && (who.username ?? "").toLowerCase() !== expect.expectedUsername.toLowerCase()) {
    return `token belongs to ${label}, expected @${expect.expectedUsername}; nothing was stored`;
  }
  return null;
}

/** Throws AccountMismatchError if `who` is not (or may not become) the tracked account. */
export async function assertTrackable(db: Queryable, who: AccountIdentity, expect: AccountExpectations): Promise<void> {
  const pinned = await getPinnedAccountId(db);
  const reason = refusalReason(pinned, who, expect);
  if (reason) throw new AccountMismatchError(reason, who, pinned);
}

/**
 * Inside the write transaction: pin `who` if nothing is pinned yet, then re-check against the
 * (possibly concurrently written) pin. Returns true if this call created the pin.
 */
export async function pinOrVerify(
  tx: Queryable,
  who: AccountIdentity,
  via: PinnedVia,
  expect: AccountExpectations,
): Promise<boolean> {
  await assertTrackable(tx, who, expect);
  const res = await tx.query(
    `INSERT INTO tracked_account (ig_user_id, username_at_pin, pinned_via) VALUES ($1, $2, $3)
     ON CONFLICT (singleton) DO NOTHING`,
    [who.igUserId, who.username, via],
  );
  const pinned = await getPinnedAccountId(tx);
  if (pinned !== who.igUserId) {
    throw new AccountMismatchError(`token belongs to id ${who.igUserId}, but this dashboard tracks id ${pinned}; nothing was stored`, who, pinned);
  }
  if (res.rowCount) {
    await audit(tx, via === "oauth_connect" ? "oauth" : "system", "tracked_account_pinned", { type: "ig_account", id: who.igUserId }, {
      username: who.username,
      via,
    });
  }
  return (res.rowCount ?? 0) > 0;
}

/** Writes the refusal to audit_log (outside the rolled-back write transaction). */
export async function auditRefusal(db: Queryable, actor: string, err: AccountMismatchError, extra: Record<string, unknown> = {}): Promise<void> {
  await audit(db, actor, "tracked_account_mismatch_rejected", { type: "ig_account", id: err.identity.igUserId }, {
    username: err.identity.username,
    pinnedIgUserId: err.pinnedIgUserId,
    reason: err.message,
    ...extra,
  });
}

/**
 * Pre-pins from IG_EXPECTED_USER_ID when set. If an account is already pinned and differs, the
 * configuration contradicts the database: fail closed.
 */
export async function ensurePinnedFromEnv(db: Queryable, cfg: Pick<InstagramConfig, "expectedUserId" | "expectedUsername">): Promise<void> {
  if (!cfg.expectedUserId) return;
  const existing = await getPinnedAccountId(db);
  if (existing === null) {
    const res = await db.query(
      `INSERT INTO tracked_account (ig_user_id, username_at_pin, pinned_via) VALUES ($1, $2, 'env')
       ON CONFLICT (singleton) DO NOTHING`,
      [cfg.expectedUserId, cfg.expectedUsername ?? null],
    );
    if (res.rowCount) {
      await audit(db, "system", "tracked_account_pinned", { type: "ig_account", id: cfg.expectedUserId }, { via: "env" });
    }
  }
  const pinned = await getPinnedAccountId(db);
  if (pinned !== cfg.expectedUserId) {
    throw new AccountMismatchError(
      `IG_EXPECTED_USER_ID (${cfg.expectedUserId}) does not match the pinned tracked account (${pinned})`,
      { igUserId: cfg.expectedUserId, username: cfg.expectedUsername ?? null },
      pinned,
    );
  }
}

/**
 * For jobs that do not themselves identify the account (account insights, media, media
 * insights, token refresh): the tracked id must be pinned, and the token in `client` must
 * belong to it (checked with GET /me). Returns the pinned id. A mismatch is audited and aborts
 * the run before anything is stored.
 */
export async function verifyClientAccount(db: Queryable, client: InstagramClient, actor = "system"): Promise<string> {
  const pinned = await getPinnedAccountId(db);
  if (!pinned) {
    throw new SyncAbort("no_account", "No tracked Instagram account is pinned yet; the account sync or OAuth connect must succeed first");
  }
  const me = await client.getMe(["user_id", "id", "username"]);
  const id = meAccountId(me);
  if (!id) throw new SyncAbort("invalid_response", "GET /me returned neither user_id nor id");
  if (id !== pinned) {
    const err = new AccountMismatchError(
      `token belongs to @${me.username ?? "?"} (id ${id}), but this dashboard tracks id ${pinned}; nothing was stored`,
      { igUserId: id, username: me.username ?? null },
      pinned,
    );
    await auditRefusal(db, actor, err);
    throw new SyncAbort(err.code, err.message, { pinnedIgUserId: pinned });
  }
  return pinned;
}
