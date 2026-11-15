/** Pure-function tests for the review fixes (no database). */
import { describe, expect, it } from "vitest";
import { getDashboardAuthConfig, getGoalConfig, getInstagramConfig, requireExpectedUsername } from "../../src/lib/config";
import { checkAccess, createSessionToken, isPublicPath, passwordMatches, safeNextPath, SESSION_MAX_AGE_SECONDS, verifySessionToken } from "../../src/lib/auth/session";
import { effectiveProductType, planMediaInsights, validateMetricValue } from "../../src/lib/instagram/metrics";
import { localDateTime, startOfLocalDay } from "../../src/lib/time";

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

describe("startOfLocalDay", () => {
  it("returns local midnight on ordinary and DST days", () => {
    expect(startOfLocalDay({ year: 2026, month: 11, day: 15 }, "America/New_York").toISOString()).toBe("2026-11-15T05:00:00.000Z");
    expect(startOfLocalDay({ year: 2026, month: 11, day: 1 }, "America/New_York").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(startOfLocalDay({ year: 2026, month: 3, day: 8 }, "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("returns the first instant of the day when midnight is skipped (America/Santiago, 2026-09-06)", () => {
    const d = startOfLocalDay({ year: 2026, month: 9, day: 6 }, "America/Santiago");
    expect(localDateTime(d, "America/Santiago")).toMatchObject({ year: 2026, month: 9, day: 6, hour: 1, minute: 0, second: 0 });
    expect(localDateTime(new Date(d.getTime() - 1000), "America/Santiago")).toMatchObject({ day: 5 });
  });
});

describe("config", () => {
  it("rejects impossible GOAL_DEADLINE dates and accepts real ones", () => {
    for (const bad of ["2026-02-31", "2026-13-01", "2026-00-10", "2025-02-29", "26-12-31"]) {
      expect(() => getGoalConfig(env({ GOAL_DEADLINE: bad }))).toThrow(/GOAL_DEADLINE/);
    }
    expect(getGoalConfig(env({ GOAL_DEADLINE: "2028-02-29" })).deadline).toBe("2028-02-29");
  });

  it("IG_EXPECTED_USERNAME has no default and is required by the entry points", () => {
    const cfg = getInstagramConfig(env({}));
    expect(cfg.expectedUsername).toBeUndefined();
    expect(() => requireExpectedUsername(cfg)).toThrow(/IG_EXPECTED_USERNAME is not set/);
    expect(getInstagramConfig(env({ IG_EXPECTED_USERNAME: " @someone ", IG_EXPECTED_USER_ID: "178" }))).toMatchObject({
      expectedUsername: "someone",
      expectedUserId: "178",
    });
  });

  it("dashboard auth fails closed", () => {
    expect(getDashboardAuthConfig(env({ NODE_ENV: "production" }))).toMatchObject({ mode: "misconfigured" });
    expect(getDashboardAuthConfig(env({ NODE_ENV: "development" }))).toMatchObject({ mode: "misconfigured" });
    expect(getDashboardAuthConfig(env({ NODE_ENV: "production", DASHBOARD_AUTH: "disabled", DASHBOARD_PASSWORD: "x" }))).toMatchObject({ mode: "misconfigured" });
    expect(getDashboardAuthConfig(env({ NODE_ENV: "development", DASHBOARD_AUTH: "disabled" }))).toEqual({ mode: "disabled" });
    expect(getDashboardAuthConfig(env({ NODE_ENV: "production", DASHBOARD_PASSWORD: "pw", SESSION_SECRET: "short" }))).toMatchObject({ mode: "misconfigured" });
    expect(getDashboardAuthConfig(env({ NODE_ENV: "production", DASHBOARD_PASSWORD: "pw", SESSION_SECRET: "s".repeat(32) }))).toMatchObject({ mode: "password" });
  });
});

describe("session tokens", () => {
  const cfg = { mode: "password" as const, password: "synthetic-pw", sessionSecret: "x".repeat(40), secureCookie: true };
  const t0 = Date.parse("2026-11-15T12:00:00Z");

  it("verifies a fresh token and rejects tampering, expiry, other secrets and a changed password", () => {
    const tok = createSessionToken(cfg, t0);
    expect(verifySessionToken(tok, cfg, t0 + 1000)).toBe(true);
    expect(verifySessionToken(tok, cfg, t0 + SESSION_MAX_AGE_SECONDS * 1000 + 1000)).toBe(false);
    expect(verifySessionToken(tok, { ...cfg, sessionSecret: "y".repeat(40) }, t0)).toBe(false);
    expect(verifySessionToken(tok, { ...cfg, password: "changed" }, t0)).toBe(false);
    const [v, exp, nonce, sig] = tok.split(".");
    expect(verifySessionToken(`${v}.${Number(exp) + 999999}.${nonce}.${sig}`, cfg, t0)).toBe(false);
    expect(verifySessionToken(`${v}.${exp}.${nonce}.${sig!.slice(0, -2)}AA`, cfg, t0)).toBe(false);
    expect(verifySessionToken(undefined, cfg, t0)).toBe(false);
    expect(verifySessionToken("garbage", cfg, t0)).toBe(false);
  });

  it("checkAccess: 503 when misconfigured, 401 without a valid cookie, ok with one or when disabled", () => {
    expect(checkAccess(undefined, { mode: "misconfigured", reason: "r" })).toMatchObject({ ok: false, status: 503 });
    expect(checkAccess(undefined, cfg)).toMatchObject({ ok: false, status: 401 });
    expect(checkAccess(createSessionToken(cfg), cfg)).toEqual({ ok: true });
    expect(checkAccess(undefined, { mode: "disabled" })).toEqual({ ok: true });
  });

  it("password comparison, redirect targets and public paths", () => {
    expect(passwordMatches("synthetic-pw", "synthetic-pw")).toBe(true);
    expect(passwordMatches("synthetic-p", "synthetic-pw")).toBe(false);
    expect(safeNextPath("/?sort=views")).toBe("/?sort=views");
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil", "", null]) expect(safeNextPath(bad)).toBe("/");
    for (const p of ["/login", "/api/cron/sync", "/api/auth/instagram/callback", "/api/auth/login"]) expect(isPublicPath(p)).toBe(true);
    for (const p of ["/", "/api/sync/status", "/api/auth/instagram/start", "/api/cron/sync/x", "/login-other"]) expect(isPublicPath(p)).toBe(false);
  });
});

describe("metric validation and planning", () => {
  it("counts must be non-negative safe integers; durations/percent finite, non-negative, bounded", () => {
    const v = (value: number) => ({ kind: "value" as const, value });
    expect(validateMetricValue("follows", v(3))).toEqual(v(3));
    expect(validateMetricValue("follows", v(0))).toEqual(v(0));
    for (const bad of [-1, 2.5, 1e300, Number.NaN, Infinity, 2 ** 53 + 2]) {
      expect(validateMetricValue("follows", v(bad)).kind).toBe("invalid");
      expect(validateMetricValue("follower_count", v(bad)).kind).toBe("invalid");
    }
    expect(validateMetricValue("ig_reels_avg_watch_time", v(1234.5))).toEqual(v(1234.5));
    expect(validateMetricValue("ig_reels_avg_watch_time", v(-0.5)).kind).toBe("invalid");
    expect(validateMetricValue("reels_skip_rate", v(45.5))).toEqual(v(45.5));
    expect(validateMetricValue("reels_skip_rate", v(100.1)).kind).toBe("invalid");
    expect(validateMetricValue("follows", { kind: "absent", reason: "x" })).toEqual({ kind: "absent", reason: "x" });
  });

  it("unknown product type withholds the FEED/STORY-only metrics; a /reel/ permalink means REELS", () => {
    const plan = planMediaInsights(null);
    expect(plan.request).not.toEqual(expect.arrayContaining(["follows"]));
    expect(plan.withheld.map((w) => w.metric).sort()).toEqual(["follows", "profile_activity", "profile_visits"]);
    expect(plan.withheld.every((w) => w.reason === "product type unknown")).toBe(true);
    expect(effectiveProductType(null, "https://www.instagram.com/reel/ABC/")).toBe("REELS");
    expect(effectiveProductType(null, "https://www.instagram.com/p/ABC/")).toBeNull();
    expect(effectiveProductType("FEED", "https://www.instagram.com/reel/ABC/")).toBe("FEED");
  });
});
