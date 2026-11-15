/**
 * Single-user access gate: DASHBOARD_PASSWORD -> a signed session cookie.
 *
 * Cookie value: "v1.<expiresAtEpochSeconds>.<nonce>.<hmac>" where hmac = HMAC-SHA256 keyed with
 * SESSION_SECRET over a fingerprint of the password plus the payload, so changing either the
 * secret or the password invalidates every session. All comparisons are constant-time.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDashboardAuthConfig, type DashboardAuthConfig } from "../config";

export const SESSION_COOKIE = "sd_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;

/** Reachable without a session. Everything else (all pages and APIs) needs one. */
export const PUBLIC_PATHS: readonly string[] = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  // Vercel Cron: protected by Authorization: Bearer $CRON_SECRET in the route itself.
  "/api/cron/sync",
  // Instagram redirects the browser here; protected by the state cookie check.
  "/api/auth/instagram/callback",
];

export function isPublicPath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PUBLIC_PATHS.includes(p);
}

type PasswordConfig = Extract<DashboardAuthConfig, { mode: "password" }>;

function sign(cfg: Pick<PasswordConfig, "password" | "sessionSecret">, payload: string): Buffer {
  const fingerprint = createHash("sha256").update(cfg.password).digest("hex");
  return createHmac("sha256", cfg.sessionSecret).update(`${fingerprint}|${payload}`).digest();
}

export function createSessionToken(cfg: Pick<PasswordConfig, "password" | "sessionSecret">, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = `v1.${exp}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${sign(cfg, payload).toString("base64url")}`;
}

export function verifySessionToken(
  token: string | undefined,
  cfg: Pick<PasswordConfig, "password" | "sessionSecret">,
  nowMs = Date.now(),
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isSafeInteger(exp) || exp * 1000 <= nowMs) return false;
  const expected = sign(cfg, parts.slice(0, 3).join("."));
  let got: Buffer;
  try {
    got = Buffer.from(parts[3]!, "base64url");
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Constant-time password check (compares SHA-256 digests, so lengths never leak). */
export function passwordMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Only same-origin relative paths are allowed as a post-login redirect target. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export type AccessDecision = { ok: true } | { ok: false; status: 401 | 503; reason: string };

/** Whether a request carrying `cookieValue` may reach a protected route. */
export function checkAccess(cookieValue: string | undefined, cfg: DashboardAuthConfig = getDashboardAuthConfig()): AccessDecision {
  if (cfg.mode === "disabled") return { ok: true };
  if (cfg.mode === "misconfigured") return { ok: false, status: 503, reason: `Dashboard login is not configured: ${cfg.reason}` };
  return verifySessionToken(cookieValue, cfg) ? { ok: true } : { ok: false, status: 401, reason: "login required" };
}

export function sessionCookieOptions(maxAge = SESSION_MAX_AGE_SECONDS) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge };
}
