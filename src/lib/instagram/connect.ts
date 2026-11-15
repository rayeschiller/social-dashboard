import type pg from "pg";
import { IG_OAUTH_SCOPES, type InstagramConfig } from "../config";
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
 * identifies the account with GET /me, refuses any account other than IG_EXPECTED_USERNAME, and
 * stores the long-lived token encrypted. Returns no token material.
 */
export async function completeOAuthCallback(
  db: pg.Pool,
  cfg: InstagramConfig,
  params: { code: string | null; state: string | null; error: string | null; errorReason: string | null; cookieState: string | undefined },
  fetchImpl?: typeof fetch,
): Promise<{ igUserId: string; username: string }> {
  if (!statesMatch(params.cookieState, params.state)) {
    throw new OAuthCallbackError("invalid_state", "OAuth state did not match; start again from /api/auth/instagram/start");
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
  const igUserId = me.user_id ?? me.id;
  if (!igUserId || !me.username) throw new OAuthCallbackError("invalid_response", "GET /me did not identify the account");
  if (cfg.expectedUsername && me.username.toLowerCase() !== cfg.expectedUsername.toLowerCase()) {
    await audit(db, "oauth", "instagram_connect_rejected", { type: "ig_account", id: igUserId }, { username: me.username });
    throw new OAuthCallbackError("unexpected_account", `@${me.username} is not the account this dashboard tracks`);
  }

  const scopes = short.permissions.length ? short.permissions : [...IG_OAUTH_SCOPES];
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
  });
  return { igUserId, username: me.username };
}
