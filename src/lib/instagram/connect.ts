import type pg from "pg";
import { AccountMismatchError, assertTrackable, ensurePinnedFromEnv, meAccountId, pinOrVerify } from "../account/tracked";
import { ConfigError, IG_OAUTH_SCOPES, requireExpectedUsername, type InstagramConfig } from "../config";
import { withTransaction } from "../db";
import { audit } from "../sync/runs";
import { upsertAccount } from "../sync/account";
import { storeToken } from "../tokens/store";
import { InstagramClient } from "./client";
import { exchangeCodeForShortLivedToken, exchangeForLongLivedToken, statesMatch } from "./oauth";

export class OAuthCallbackError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}

/**
 * Completes the OAuth callback: verifies state, exchanges code -> short-lived -> long-lived token,
 * identifies the account with GET /me and stores the long-lived token encrypted. Fails closed:
 * without IG_EXPECTED_USERNAME nothing happens at all. The first connect pins the account's
 * stable id (if its username matches); afterwards any token whose id differs from the pinned id
 * is refused, audited, and not stored. Returns no token material.
 */
export async function completeOAuthCallback(
  db: pg.Pool,
  cfg: InstagramConfig,
  params: { code: string | null; state: string | null; error: string | null; errorReason: string | null; cookieState: string | undefined },
  fetchImpl?: typeof fetch,
): Promise<{ igUserId: string; username: string }> {
  let expectedUsername: string;
  try {
    expectedUsername = requireExpectedUsername(cfg);
  } catch (err) {
    if (err instanceof ConfigError) throw new OAuthCallbackError("config_error", err.message);
    throw err;
  }
  if (!statesMatch(params.cookieState, params.state)) {
    throw new OAuthCallbackError("invalid_state", "OAuth state did not match; start again from /api/auth/instagram/start");
  }
  try {
    await ensurePinnedFromEnv(db, cfg);
  } catch (err) {
    if (err instanceof AccountMismatchError) throw new OAuthCallbackError("config_error", err.message);
    throw err;
  }
  if (params.error) {
    throw new OAuthCallbackError("denied", `Authorization was not granted (${params.errorReason ?? params.error})`);
  }
  if (!params.code) throw new OAuthCallbackError("missing_code", "No authorization code was returned");

  const short = await exchangeCodeForShortLivedToken(cfg, params.code, fetchImpl);
  const long = await exchangeForLongLivedToken(cfg, short.accessToken, fetchImpl);
  const issuedAt = new Date();

  const me = await new InstagramClient({
    accessToken: long.accessToken,
    authMode: "db",
    apiVersion: cfg.apiVersion,
    baseUrl: cfg.graphBaseUrl,
    fetchImpl,
  }).getMe(["user_id", "id", "username", "account_type"]);
  const igUserId = meAccountId(me);
  if (!igUserId || !me.username) throw new OAuthCallbackError("invalid_response", "GET /me did not identify the account");
  const who = { igUserId, username: me.username };
  const expect = { expectedUsername, expectedUserId: cfg.expectedUserId };

  const scopes = short.permissions.length ? short.permissions : [...IG_OAUTH_SCOPES];
  try {
    await assertTrackable(db, who, expect);
    await withTransaction(db, async (tx) => {
      await upsertAccount(tx, { igUserId, appScopedId: me.id ?? null, username: me.username!, accountType: me.account_type ?? null });
      const tokenId = await storeToken(tx, {
        igUserId,
        accessToken: long.accessToken,
        scopes,
        issuedAt,
        expiresInSeconds: long.expiresIn,
        obtainedVia: "oauth_callback",
      });
      await audit(tx, "oauth", "instagram_account_connected", { type: "ig_account", id: igUserId }, { username: me.username, scopes, tokenId });
      // Pins on the first connect; re-checks the pin (rolls everything back on a mismatch).
      await pinOrVerify(tx, who, "oauth_connect", expect);
    });
  } catch (err) {
    if (err instanceof AccountMismatchError) {
      await audit(db, "oauth", "instagram_connect_rejected", { type: "ig_account", id: igUserId }, {
        username: me.username,
        pinnedIgUserId: err.pinnedIgUserId,
        reason: err.message,
      });
      throw new OAuthCallbackError("unexpected_account", `@${me.username} is not the account this dashboard tracks; nothing was stored`);
    }
    throw err;
  }
  return { igUserId, username: me.username };
}
