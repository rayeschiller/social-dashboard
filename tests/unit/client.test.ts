import { describe, expect, it } from "vitest";
import { InstagramClient, parseInsightTotals } from "../../src/lib/instagram/client";
import { classifyGraphError, InstagramApiError, statusForClassification } from "../../src/lib/instagram/errors";
import { planMediaInsights } from "../../src/lib/instagram/metrics";
import { redact, safeEndpoint } from "../../src/lib/redact";
import { fakeClient, graphError } from "../helpers/fake-graph";

describe("InstagramClient auth", () => {
  it("sends the token only in the Authorization header", async () => {
    const { client, calls } = fakeClient([() => ({ body: { user_id: "1", username: "synthetic" } })], "secret-xyz");
    await client.getMe(["user_id", "username"]);
    expect(calls[0]!.authorization).toBe("Bearer secret-xyz");
    expect(calls[0]!.url.searchParams.has("access_token")).toBe(false);
    expect(calls[0]!.url.toString()).not.toContain("secret-xyz");
  });

  it("refuses to build a URL with access_token", () => {
    const c = new InstagramClient({ accessToken: "t", authMode: "env" });
    expect(() => c.buildUrl("me", { access_token: "t" })).toThrow(/query parameter/);
  });

  it("does not leak the token through JSON serialisation", () => {
    const c = new InstagramClient({ accessToken: "secret-xyz", authMode: "env" });
    expect(JSON.stringify(c)).not.toContain("secret-xyz");
  });
});

describe("pagination", () => {
  it("follows paging.next on the same host and strips any access_token in it", async () => {
    const { client, calls } = fakeClient([
      (u) =>
        u.searchParams.get("after") === "c2"
          ? { body: { data: [{ id: "m3" }] } }
          : {
              body: {
                data: [{ id: "m1" }, { id: "m2" }],
                paging: { next: "https://graph.instagram.com/v27.0/42/media?after=c2&access_token=LEAKED" },
              },
            },
    ]);
    const ids: string[] = [];
    for await (const page of client.iterateMedia("42", ["id"])) ids.push(...page.map((m) => m.id));
    expect(ids).toEqual(["m1", "m2", "m3"]);
    expect(calls[1]!.url.searchParams.has("access_token")).toBe(false);
  });

  it("refuses paging URLs on another host", async () => {
    const { client } = fakeClient([() => ({ body: { data: [{ id: "m1" }], paging: { next: "https://evil.example/next" } } })]);
    const it = client.iterateMedia("42", ["id"]);
    await it.next();
    await expect(it.next()).rejects.toMatchObject({ classification: "invalid_response" });
  });
});

describe("retries and error mapping", () => {
  it("retries transient 5xx errors with backoff and then succeeds", async () => {
    let n = 0;
    const { client, calls } = fakeClient([() => (++n < 3 ? graphError(2, "Service temporarily unavailable", 503) : { body: { username: "ok" } })]);
    const me = await client.getMe(["username"]);
    expect(me.username).toBe("ok");
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxRetries on transient errors", async () => {
    const { client, calls } = fakeClient([() => graphError(1, "An unknown error occurred", 500)]);
    await expect(client.getMe(["username"])).rejects.toMatchObject({ classification: "transient", attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  it("does not retry auth errors (code 190)", async () => {
    const { client, calls } = fakeClient([() => graphError(190, "Invalid OAuth access token - Cannot parse access token", 401)]);
    const err = await client.getMe(["username"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstagramApiError);
    expect((err as InstagramApiError).classification).toBe("auth");
    expect((err as InstagramApiError).fatalForRun).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not wait out long rate limits", async () => {
    const { client, calls } = fakeClient([() => graphError(4, "Application request limit reached", 400)]);
    await expect(client.getMe(["username"])).rejects.toMatchObject({ classification: "rate_limit" });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [400, { code: 190, message: "Invalid OAuth 2.0 Access Token" }, "auth"],
    [400, { code: 10, message: "Application does not have permission for this action" }, "permission"],
    [400, { code: 10, message: "(#10) Not enough viewers for the media to show insights" }, "insufficient_data"],
    [400, { code: 100, message: "The Media Insights API does not support the follows metric for this media product type" }, "unsupported_metric"],
    [400, { code: 100, message: "(#100) metric[0] must be one of the following values: views, reach" }, "unsupported_metric"],
    [400, { code: 100, error_subcode: 33, message: "Unsupported get request. Object does not exist" }, "not_found"],
    [400, { code: 100, message: "Tried accessing nonexisting field (shortcode)" }, "invalid_request"],
    [400, { code: 17, message: "User request limit reached" }, "rate_limit"],
    [500, { code: 2, message: "Service temporarily unavailable" }, "transient"],
    [429, undefined, "rate_limit"],
  ] as const)("HTTP %s %j -> %s", (status, body, expected) => {
    expect(classifyGraphError(status, body)).toBe(expected);
  });

  it("maps classifications onto stored statuses", () => {
    expect(statusForClassification("unsupported_metric")).toBe("unsupported");
    expect(statusForClassification("insufficient_data")).toBe("unavailable");
    expect(statusForClassification("transient")).toBe("error");
    expect(statusForClassification("auth")).toBe("error");
  });
});

describe("insights parsing", () => {
  it("reads 0 as a real value and an omitted metric as absent (never 0)", () => {
    const m = parseInsightTotals(
      { data: [{ name: "follows", values: [{ value: 0 }] }, { name: "reach", total_value: { value: 17 } }] },
      ["follows", "reach", "views"],
    );
    expect(m.get("follows")).toEqual({ kind: "value", value: 0 });
    expect(m.get("reach")).toEqual({ kind: "value", value: 17 });
    expect(m.get("views")?.kind).toBe("absent");
  });

  it("treats non-numeric values as invalid", () => {
    const m = parseInsightTotals({ data: [{ name: "views", values: [{ value: "12" }] }] }, ["views"]);
    expect(m.get("views")?.kind).toBe("invalid");
  });
});

describe("metric plans per media_product_type (Meta docs)", () => {
  it("never requests follows / profile_visits / profile_activity for REELS", () => {
    const plan = planMediaInsights("REELS");
    expect(plan.request).not.toContain("follows");
    expect(plan.request).not.toContain("profile_visits");
    expect(plan.request).not.toContain("profile_activity");
    expect(plan.unsupported.map((u) => u.metric)).toEqual(expect.arrayContaining(["follows", "profile_visits", "profile_activity"]));
    expect(plan.request).toEqual(expect.arrayContaining(["views", "reach", "ig_reels_avg_watch_time", "reels_skip_rate"]));
  });

  it("requests follows for FEED but not Reels-only metrics", () => {
    const plan = planMediaInsights("FEED");
    expect(plan.request).toContain("follows");
    expect(plan.request).not.toContain("ig_reels_avg_watch_time");
  });

  it("never requests deprecated impressions or plays", () => {
    for (const pt of ["FEED", "REELS", "STORY", null]) {
      const plan = planMediaInsights(pt);
      expect(plan.request).not.toContain("impressions");
      expect(plan.request).not.toContain("plays");
    }
  });

  it("falls back to asking the API per metric when the product type is unknown", () => {
    const plan = planMediaInsights(undefined);
    expect(plan.productTypeUnknown).toBe(true);
    expect(plan.unsupported).toHaveLength(0);
  });
});

describe("redaction", () => {
  it("removes tokens from strings and URLs", () => {
    expect(redact("GET /me?access_token=abc123&fields=id")).toBe("GET /me?access_token=[REDACTED]&fields=id");
    expect(redact("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [REDACTED]");
    expect(safeEndpoint("https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=s3cr3t")).not.toContain("s3cr3t");
  });
});
