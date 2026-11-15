/**
 * Business Login for Instagram (OAuth 2.0 authorization code flow).
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/
 * https://developers.facebook.com/docs/instagram-platform/reference/oauth-authorize/
 * https://developers.facebook.com/docs/instagram-platform/reference/access_token/
 *
 * 1. Redirect to https://www.instagram.com/oauth/authorize with client_id, redirect_uri (must
 *    EXACTLY match a URI in the App Dashboard), response_type=code, scope, state (CSRF).
 * 2. POST https://api.instagram.com/oauth/access_token (form) -> short-lived token (1 hour).
 *    "#_" is appended to the redirect; it is not part of the code.
 * 3. GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=...
 *    -> long-lived token (60 days). The short-lived token goes in the Authorization header.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { IG_OAUTH_SCOPES, type InstagramConfig } from "../config";
import { safeEndpoint } from "../redact";
import { InstagramClient } from "./client";
import { classifyGraphError, InstagramApiError, type GraphErrorBody } from "./errors";

export const OAUTH_STATE_COOKIE = "ig_oauth_state";
export const OAUTH_STATE_MAX_AGE_SECONDS = 600;

export function newOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function statesMatch(expected: string | undefined, received: string | null | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildAuthorizeUrl(cfg: InstagramConfig, state: string): string {
  if (!cfg.appId) throw new Error("IG_APP_ID is not set");
  if (!cfg.redirectUri) throw new Error("IG_REDIRECT_URI is not set");
  const u = new URL(cfg.authorizeUrl);
  u.searchParams.set("client_id", cfg.appId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", IG_OAUTH_SCOPES.join(","));
  u.searchParams.set("state", state);
  return u.toString();
}

/** Strip the "#_" Meta appends to the code. */
export function cleanAuthCode(code: string): string {
  return code.replace(/#_$/, "");
}

export interface ShortLivedToken {
  accessToken: string;
  userId: string | null;
  permissions: string[];
}

export async function exchangeCodeForShortLivedToken(
  cfg: InstagramConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShortLivedToken> {
  if (!cfg.appId || !cfg.appSecret || !cfg.redirectUri) {
    throw new Error("IG_APP_ID, IG_APP_SECRET and IG_REDIRECT_URI must be set");
  }
  const url = `${cfg.oauthBaseUrl}/oauth/access_token`;
  const endpoint = safeEndpoint(url);
  const form = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    grant_type: "authorization_code",
    redirect_uri: cfg.redirectUri,
    code: cleanAuthCode(code),
  });
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new InstagramApiError({ message: `network error: ${(err as Error).message}`, classification: "network", endpoint });
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Docs show both a flat object and one wrapped in data[]; accept either.
  const node = (Array.isArray(body.data) ? body.data[0] : body) as Record<string, unknown> | undefined;
  if (!res.ok || !node || typeof node.access_token !== "string") {
    const errBody: GraphErrorBody = {
      message:
        (typeof body.error_message === "string" && body.error_message) ||
        ((body.error as GraphErrorBody | undefined)?.message ?? `HTTP ${res.status}`),
      code: typeof body.code === "number" ? body.code : (body.error as GraphErrorBody | undefined)?.code,
      type: typeof body.error_type === "string" ? body.error_type : undefined,
    };
    throw new InstagramApiError({
      message: errBody.message!,
      classification: classifyGraphError(res.status, errBody),
      endpoint,
      httpStatus: res.status,
      code: errBody.code ?? null,
      type: errBody.type ?? null,
    });
  }
  const perms = node.permissions;
  return {
    accessToken: node.access_token,
    userId: node.user_id != null ? String(node.user_id) : null,
    permissions: Array.isArray(perms) ? perms.map(String) : typeof perms === "string" ? perms.split(",").filter(Boolean) : [],
  };
}

export async function exchangeForLongLivedToken(
  cfg: InstagramConfig,
  shortLivedToken: string,
  fetchImpl?: typeof fetch,
): Promise<{ accessToken: string; expiresIn: number | null }> {
  if (!cfg.appSecret) throw new Error("IG_APP_SECRET is not set");
  const client = new InstagramClient({
    accessToken: shortLivedToken,
    authMode: "db",
    baseUrl: cfg.graphBaseUrl,
    apiVersion: cfg.apiVersion,
    fetchImpl,
  });
  const body = await client.getJson<{ access_token?: unknown; expires_in?: unknown }>(
    client.buildUrl("access_token", { grant_type: "ig_exchange_token", client_secret: cfg.appSecret }, false),
  );
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new InstagramApiError({
      message: "access_token exchange response had no access_token",
      classification: "invalid_response",
      endpoint: "graph.instagram.com/access_token",
    });
  }
  return { accessToken: body.access_token, expiresIn: typeof body.expires_in === "number" ? body.expires_in : null };
}
