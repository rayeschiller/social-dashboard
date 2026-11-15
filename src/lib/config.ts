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

export function getGoalConfig(env: NodeJS.ProcessEnv = process.env): GoalConfig {
  const followers = env.GOAL_FOLLOWERS ? Number(env.GOAL_FOLLOWERS) : DEFAULT_GOAL_FOLLOWERS;
  if (!Number.isInteger(followers) || followers <= 0) {
    throw new Error("GOAL_FOLLOWERS must be a positive integer");
  }
  const deadline = env.GOAL_DEADLINE || DEFAULT_GOAL_DEADLINE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    throw new Error("GOAL_DEADLINE must be YYYY-MM-DD");
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
  expectedUsername?: string;
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
    expectedUsername: env.IG_EXPECTED_USERNAME || undefined,
    authMode: mode,
    envAccessToken: env.IG_ACCESS_TOKEN || undefined,
  };
}

/** OAuth scopes for Business Login for Instagram (insights read only). */
export const IG_OAUTH_SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"] as const;
