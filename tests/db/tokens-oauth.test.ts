/** Token storage, refresh job and OAuth callback against the real local Postgres. Synthetic tokens only. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InstagramConfig } from "../../src/lib/config";
import { InstagramClient } from "../../src/lib/instagram/client";
import { completeOAuthCallback } from "../../src/lib/instagram/connect";
import { buildAuthorizeUrl } from "../../src/lib/instagram/oauth";
import { refreshTokenJob } from "../../src/lib/sync";
import { getActiveToken, storeToken } from "../../src/lib/tokens/store";
import { fakeFetch, type Route } from "../helpers/fake-graph";
import { insertAccount } from "../helpers/seed";
import { closeTestPool, resetDb, testPool } from "../helpers/test-db";

const db = testPool();
const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = savedKey;
  await closeTestPool();
});
beforeEach(() => resetDb(db));

const cfg: InstagramConfig = {
  apiVersion: "v27.0",
  graphBaseUrl: "https://graph.instagram.com",
  oauthBaseUrl: "https://api.instagram.com",
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  appId: "000000000000000",
  appSecret: "synthetic-app-secret",
  redirectUri: "https://dashboard.example/api/auth/instagram/callback",
  expectedUsername: "synthetic_user",
  authMode: "db",
};

describe("token storage", () => {
  it("stores tokens encrypted and returns the newest active one", async () => {
    const acct = await insertAccount(db);
    await storeToken(db, { igUserId: acct, accessToken: "SYNTHETIC-old", scopes: ["a"], issuedAt: new Date("2026-10-01T00:00:00Z"), expiresInSeconds: 5_184_000, obtainedVia: "oauth_callback" });
    await storeToken(db, { igUserId: acct, accessToken: "SYNTHETIC-new", scopes: ["a"], issuedAt: new Date("2026-11-01T00:00:00Z"), expiresInSeconds: 5_184_000, obtainedVia: "refresh" });
    const active = await getActiveToken(db);
    expect(active?.accessToken).toBe("SYNTHETIC-new");
    expect(active?.expiresAt?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    const { rows } = await db.query("SELECT token_ciphertext::text AS c, superseded_at FROM oauth_tokens ORDER BY id");
    expect(rows.every((r) => !String(r.c).includes("SYNTHETIC"))).toBe(true);
    expect(rows[0].superseded_at).not.toBeNull();
    expect(rows[1].superseded_at).toBeNull();
  });
});

describe("refreshTokenJob", () => {
  const dbClient = () => new InstagramClient({ accessToken: "unused", authMode: "db" });

  it("is skipped outside db auth mode", async () => {
    const run = await refreshTokenJob({ db, client: new InstagramClient({ accessToken: "x", authMode: "proxy" }), trigger: "test" });
    expect(run).toMatchObject({ status: "skipped", errorCode: "not_applicable" });
  });

  it("refreshes a due token using the Authorization header and stores the new one", async () => {
    const acct = await insertAccount(db);
    const issuedAt = new Date(Date.now() - 40 * 86_400_000);
    await storeToken(db, { igUserId: acct, accessToken: "SYNTHETIC-due", scopes: [], issuedAt, expiresInSeconds: 60 * 86_400, obtainedVia: "oauth_callback" });
    const f = fakeFetch([
      (u) => (u.pathname === "/refresh_access_token" ? { body: { access_token: "SYNTHETIC-refreshed", token_type: "bearer", expires_in: 5_184_000 } } : undefined),
      (u) => (u.pathname.endsWith("/me") ? { body: { user_id: acct, id: "app-1", username: "synthetic_user" } } : undefined),
    ]);
    const run = await refreshTokenJob({ db, client: dbClient(), trigger: "test" }, { fetchImpl: f.fetch });
    expect(run.status).toBe("succeeded");
    // /me with the stored token (account check), refresh, /me with the new token (account check)
    expect(f.calls.map((c) => [c.url.pathname.replace(/^\/v[\d.]+/, ""), c.authorization])).toEqual([
      ["/me", "Bearer SYNTHETIC-due"],
      ["/refresh_access_token", "Bearer SYNTHETIC-due"],
      ["/me", "Bearer SYNTHETIC-refreshed"],
    ]);
    const refreshCall = f.calls[1]!;
    expect(refreshCall.url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(refreshCall.url.searchParams.has("access_token")).toBe(false);
    expect((await getActiveToken(db))?.accessToken).toBe("SYNTHETIC-refreshed");
    const { rows } = await db.query("SELECT stats::text AS s, error_message FROM sync_runs WHERE id = $1", [run.id]);
    expect(rows[0].s).not.toContain("SYNTHETIC");
  });

  it("refuses to refresh (and stores nothing) when the stored token belongs to another account", async () => {
    const acct = await insertAccount(db);
    await storeToken(db, { igUserId: acct, accessToken: "SYNTHETIC-due", scopes: [], issuedAt: new Date(Date.now() - 40 * 86_400_000), expiresInSeconds: 60 * 86_400, obtainedVia: "oauth_callback" });
    const f = fakeFetch([
      (u) => (u.pathname === "/refresh_access_token" ? { body: { access_token: "SYNTHETIC-refreshed", expires_in: 5_184_000 } } : undefined),
      (u) => (u.pathname.endsWith("/me") ? { body: { user_id: "17840000000000999", username: "someone_else" } } : undefined),
    ]);
    const run = await refreshTokenJob({ db, client: dbClient(), trigger: "test" }, { fetchImpl: f.fetch });
    expect(run).toMatchObject({ status: "failed", errorCode: "unexpected_account" });
    expect(f.calls.some((c) => c.url.pathname === "/refresh_access_token")).toBe(false);
    expect((await db.query("SELECT count(*)::int AS n FROM oauth_tokens")).rows[0].n).toBe(1);
    const audit = await db.query("SELECT action FROM audit_log");
    expect(audit.rows.map((r) => r.action)).toContain("tracked_account_mismatch_rejected");
  });

  it("skips a token that is not due", async () => {
    const acct = await insertAccount(db);
    await storeToken(db, { igUserId: acct, accessToken: "SYNTHETIC-fresh", scopes: [], issuedAt: new Date(Date.now() - 2 * 86_400_000), expiresInSeconds: 60 * 86_400, obtainedVia: "oauth_callback" });
    const run = await refreshTokenJob({ db, client: dbClient(), trigger: "test" });
    expect(run).toMatchObject({ status: "skipped", errorCode: "not_due" });
  });
});

describe("OAuth", () => {
  it("builds the authorize URL with exact redirect URI, scopes and state", () => {
    const u = new URL(buildAuthorizeUrl(cfg, "state123"));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(u.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_insights");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("state123");
  });

  const routes = (username: string): Route[] => [
    (u) => (u.host === "api.instagram.com" ? { body: { access_token: "SYNTHETIC-short", user_id: 1, permissions: ["instagram_business_basic"] } } : undefined),
    (u) => (u.pathname === "/access_token" ? { body: { access_token: "SYNTHETIC-long", token_type: "bearer", expires_in: 5_184_000 } } : undefined),
    (u) => (u.pathname.endsWith("/me") ? { body: { user_id: "17840000000000001", id: "app-1", username } } : undefined),
  ];

  it("rejects a state mismatch before any network call", async () => {
    const f = fakeFetch(routes("synthetic_user"));
    await expect(
      completeOAuthCallback(db, cfg, { code: "c", state: "evil", error: null, errorReason: null, cookieState: "good" }, f.fetch),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(f.calls).toHaveLength(0);
  });

  it("exchanges short -> long-lived token, stores it encrypted, never puts tokens in URLs", async () => {
    const f = fakeFetch(routes("synthetic_user"));
    const res = await completeOAuthCallback(db, cfg, { code: "AQB-code#_", state: "s", error: null, errorReason: null, cookieState: "s" }, f.fetch);
    expect(res.username).toBe("synthetic_user");
    expect((await getActiveToken(db))?.accessToken).toBe("SYNTHETIC-long");
    for (const c of f.calls) expect(c.url.toString()).not.toMatch(/SYNTHETIC|access_token=/);
    expect(f.calls[1]!.authorization).toBe("Bearer SYNTHETIC-short");
    expect(f.calls[2]!.authorization).toBe("Bearer SYNTHETIC-long");
    const audit = await db.query("SELECT action, detail::text AS d FROM audit_log");
    expect(audit.rows[0].action).toBe("instagram_account_connected");
    expect(audit.rows[0].d).not.toContain("SYNTHETIC");
  });

  it("refuses to store a token for an unexpected account", async () => {
    const f = fakeFetch(routes("someone_else"));
    await expect(
      completeOAuthCallback(db, cfg, { code: "c", state: "s", error: null, errorReason: null, cookieState: "s" }, f.fetch),
    ).rejects.toMatchObject({ code: "unexpected_account" });
    expect((await db.query("SELECT count(*)::int AS n FROM oauth_tokens")).rows[0].n).toBe(0);
  });
});
