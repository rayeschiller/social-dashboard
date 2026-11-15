/**
 * Runtime configuration read from environment variables. Nothing here is a metric value:
 * GOAL_FOLLOWERS / GOAL_DEADLINE are the target, not observations.
 */

export type AuthMode = "auto" | "db" | "env" | "proxy";

export interface GoalConfig {
  /** Target follower count. */
  followers: number;
  /** Last day (inclusive) of the goal, YYYY-MM-DD, interpreted in `timezone`. */
  deadline: string;
  /** IANA timezone used for calendar-day boundaries and days-remaining. */
  timezone: string;
}

const DEFAULT_GOAL_FOLLOWERS = 100_000;
const DEFAULT_GOAL_DEADLINE = "2026-12-31";
const DEFAULT_TIMEZONE = "America/New_York";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True for "YYYY-MM-DD" strings naming a date that exists (rejects 2026-02-31, 2026-13-01). */
export function isRealCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** A required setting is missing or invalid. Entry points fail closed on it. */
export class ConfigError extends Error {
  readonly code = "config_error";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function getGoalConfig(env: NodeJS.ProcessEnv = process.env): GoalConfig {
  const followers = env.GOAL_FOLLOWERS ? Number(env.GOAL_FOLLOWERS) : DEFAULT_GOAL_FOLLOWERS;
  if (!Number.isInteger(followers) || followers <= 0) {
    throw new Error("GOAL_FOLLOWERS must be a positive integer");
  }
  const deadline = env.GOAL_DEADLINE || DEFAULT_GOAL_DEADLINE;
  if (!isRealCalendarDate(deadline)) {
    throw new Error(`GOAL_DEADLINE must be a real calendar date in YYYY-MM-DD form, got "${deadline}"`);
  }
  const timezone = env.REPORTING_TIMEZONE || DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) {
    throw new Error(`REPORTING_TIMEZONE is not a valid IANA timezone: ${timezone}`);
  }
  return { followers, deadline, timezone };
}

export interface InstagramConfig {
  apiVersion: string;
  graphBaseUrl: string;
  oauthBaseUrl: string;
  authorizeUrl: string;
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
  /**
   * Username the connected account must have before it is pinned (IG_EXPECTED_USERNAME).
   * Required by the sync and OAuth entry points (see requireExpectedUsername); once the account
   * is pinned, its stable id is compared instead.
   */
  expectedUsername?: string;
  /** Optional stable IG user id (IG_EXPECTED_USER_ID) used to pre-pin the tracked account. */
  expectedUserId?: string;
  authMode: AuthMode;
  envAccessToken?: string;
}

export function getInstagramConfig(env: NodeJS.ProcessEnv = process.env): InstagramConfig {
  const mode = (env.IG_AUTH_MODE || "auto") as AuthMode;
  if (!["auto", "db", "env", "proxy"].includes(mode)) {
    throw new Error(`IG_AUTH_MODE must be one of auto|db|env|proxy, got ${mode}`);
  }
  return {
    apiVersion: env.IG_API_VERSION || "v27.0",
    graphBaseUrl: "https://graph.instagram.com",
    oauthBaseUrl: "https://api.instagram.com",
    authorizeUrl: "https://www.instagram.com/oauth/authorize",
    appId: env.IG_APP_ID || undefined,
    appSecret: env.IG_APP_SECRET || undefined,
    redirectUri: env.IG_REDIRECT_URI || undefined,
    expectedUsername: env.IG_EXPECTED_USERNAME?.trim().replace(/^@/, "") || undefined,
    expectedUserId: env.IG_EXPECTED_USER_ID?.trim() || undefined,
    authMode: mode,
    envAccessToken: env.IG_ACCESS_TOKEN || undefined,
  };
}

/**
 * Fail closed: the sync jobs and the OAuth flow refuse to run without IG_EXPECTED_USERNAME, so a
 * token for some other account can never be adopted as the tracked account. There is no default.
 */
export function requireExpectedUsername(cfg: InstagramConfig): string {
  if (!cfg.expectedUsername) {
    throw new ConfigError(
      "IG_EXPECTED_USERNAME is not set. Set it to the Instagram username this dashboard tracks; sync and OAuth refuse to run without it.",
    );
  }
  return cfg.expectedUsername;
}

// ---------------------------------------------------------------------------------------------
// Dashboard access control
// ---------------------------------------------------------------------------------------------

export type DashboardAuthConfig =
  | { mode: "password"; password: string; sessionSecret: string; secureCookie: boolean }
  | { mode: "disabled" }
  | { mode: "misconfigured"; reason: string };

/**
 * DASHBOARD_PASSWORD + SESSION_SECRET enable the single-user login gate. Without a password the
 * gate fails closed (every protected route answers 503), except that DASHBOARD_AUTH=disabled
 * turns it off explicitly when NODE_ENV is not 'production'.
 */
export function getDashboardAuthConfig(env: NodeJS.ProcessEnv = process.env): DashboardAuthConfig {
  const production = env.NODE_ENV === "production";
  if (env.DASHBOARD_AUTH === "disabled") {
    if (production) return { mode: "misconfigured", reason: "DASHBOARD_AUTH=disabled is not allowed when NODE_ENV=production" };
    return { mode: "disabled" };
  }
  const password = env.DASHBOARD_PASSWORD;
  if (!password) {
    return {
      mode: "misconfigured",
      reason: production
        ? "DASHBOARD_PASSWORD is not set"
        : "DASHBOARD_PASSWORD is not set (set DASHBOARD_AUTH=disabled to turn the login off outside production)",
    };
  }
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) {
    return { mode: "misconfigured", reason: "SESSION_SECRET must be set to at least 32 characters (openssl rand -hex 32)" };
  }
  return { mode: "password", password, sessionSecret, secureCookie: true };
}

/** OAuth scopes for Business Login for Instagram (insights read only). */
export const IG_OAUTH_SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"] as const;
