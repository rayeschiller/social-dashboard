import { getInstagramConfig, type InstagramConfig } from "../config";
import type { Queryable } from "../db";
import { getActiveToken } from "../tokens/store";
import { InstagramClient, PROXY_PLACEHOLDER_TOKEN, type ClientAuthMode } from "./client";
import { NoTokenError } from "./errors";

export interface ResolvedAuth {
  mode: ClientAuthMode;
  /** The value sent in the Authorization header. In proxy mode it is a placeholder. */
  token: string;
  /** Present when the token came from oauth_tokens. */
  tokenId?: number;
  igUserId?: string;
  issuedAt?: Date;
  expiresAt?: Date | null;
}

/**
 * Picks the credential for API calls, per IG_AUTH_MODE:
 *   env   -> IG_ACCESS_TOKEN
 *   db    -> newest active encrypted token of the TRACKED (pinned) account from the OAuth flow
 *   proxy -> placeholder; the outbound proxy injects the real Authorization header
 *   auto  -> env if IG_ACCESS_TOKEN is set, else db if a token is stored, else NoTokenError
 */
export async function resolveAuth(db: Queryable, cfg: InstagramConfig = getInstagramConfig()): Promise<ResolvedAuth> {
  const mode = cfg.authMode;
  if (mode === "proxy") return { mode: "proxy", token: PROXY_PLACEHOLDER_TOKEN };
  if (mode === "env" || (mode === "auto" && cfg.envAccessToken)) {
    if (!cfg.envAccessToken) throw new NoTokenError("IG_AUTH_MODE=env but IG_ACCESS_TOKEN is empty");
    return { mode: "env", token: cfg.envAccessToken };
  }
  const stored = await getActiveToken(db);
  if (!stored) {
    throw new NoTokenError(
      mode === "db"
        ? "IG_AUTH_MODE=db but no active OAuth token is stored; connect the account via /api/auth/instagram/start"
        : "No Instagram token: set IG_ACCESS_TOKEN, connect via /api/auth/instagram/start, or use IG_AUTH_MODE=proxy",
    );
  }
  return {
    mode: "db",
    token: stored.accessToken,
    tokenId: stored.id,
    igUserId: stored.igUserId,
    issuedAt: stored.issuedAt,
    expiresAt: stored.expiresAt,
  };
}

export function clientFor(auth: ResolvedAuth, cfg: InstagramConfig = getInstagramConfig()): InstagramClient {
  return new InstagramClient({
    accessToken: auth.token,
    authMode: auth.mode,
    apiVersion: cfg.apiVersion,
    baseUrl: cfg.graphBaseUrl,
  });
}
