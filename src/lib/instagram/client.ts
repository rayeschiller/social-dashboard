/**
 * Typed client for the Instagram API with Instagram Login (host graph.instagram.com).
 *
 * Authentication: ALWAYS the `Authorization: Bearer <token>` header, never the `access_token`
 * query parameter. Meta's reference pages show `access_token=` in their examples, but Graph API
 * accepts the OAuth 2.0 bearer header; in the dev environment an outbound proxy injects/replaces
 * that header, so the token value the client holds may be a placeholder ("proxy" auth mode).
 * Tokens never appear in URLs, logs, errors or the database in clear text.
 *
 * References (re-read 2026-11-15):
 *   GET /me                     https://developers.facebook.com/docs/instagram-platform/reference/me/
 *   IG User fields              https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/
 *   GET /<IG_ID>/media          https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
 *   IG Media fields             https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/
 *   GET /<MEDIA_ID>/insights    https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/
 *   GET /<IG_ID>/insights       https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/
 *   GET /refresh_access_token   https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/
 *   Rate limiting               https://developers.facebook.com/docs/instagram-platform/overview/ (Rate Limiting:
 *                               "Calls within 24 hours = 4800 * Number of Impressions")
 */
import { safeEndpoint } from "../redact";
import { classifyGraphError, InstagramApiError, type GraphErrorBody } from "./errors";

export type ClientAuthMode = "db" | "env" | "proxy";

/** Sent when the real token is injected by an outbound proxy. Never a real credential. */
export const PROXY_PLACEHOLDER_TOKEN = "proxy-injected";

export interface InstagramClientOptions {
  accessToken: string;
  authMode: ClientAuthMode;
  apiVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries for transient / network errors (default 3). */
  maxRetries?: number;
  timeoutMs?: number;
}

export interface IgMe {
  /** Instagram professional account ID (Instagram Login `user_id`). */
  user_id?: string;
  /** App-scoped user ID. */
  id?: string;
  username?: string;
  account_type?: string;
  followers_count?: unknown;
  follows_count?: unknown;
  media_count?: unknown;
}

export interface IgMediaNode {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  shortcode?: string;
  thumbnail_url?: string;
  media_url?: string;
  timestamp?: string;
  like_count?: unknown;
  comments_count?: unknown;
}

/** Outcome of reading one metric from an insights response. */
export type InsightValue =
  | { kind: "value"; value: number }
  | { kind: "absent"; reason: string }
  | { kind: "invalid"; reason: string };

export interface UserInsightPoint {
  endTime: Date;
  value: InsightValue;
}

interface Paged<T> {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class InstagramClient {
  readonly authMode: ClientAuthMode;
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  /** Count of HTTP requests sent (for sync stats). */
  requestCount = 0;

  constructor(opts: InstagramClientOptions) {
    if (!opts.accessToken) throw new Error("InstagramClient requires an access token value");
    this.token = opts.accessToken;
    this.authMode = opts.authMode;
    this.apiVersion = opts.apiVersion ?? "v27.0";
    this.baseUrl = (opts.baseUrl ?? "https://graph.instagram.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** Never print the token, even via util.inspect / JSON.stringify. */
  toJSON() {
    return { authMode: this.authMode, apiVersion: this.apiVersion, baseUrl: this.baseUrl };
  }

  buildUrl(path: string, params: Record<string, string | number | undefined> = {}, versioned = true): string {
    const prefix = versioned ? `/${this.apiVersion}` : "";
    const url = new URL(`${this.baseUrl}${prefix}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (k === "access_token") throw new Error("access_token must not be sent as a query parameter");
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** GET a URL with bearer auth, retries and error classification. */
  async getJson<T>(url: string): Promise<T> {
    const endpoint = safeEndpoint(url);
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await this.once<T>(url, endpoint);
      } catch (err) {
        if (!(err instanceof InstagramApiError)) throw err;
        err.attempts = attempt;
        const delay = this.retryDelay(err, attempt);
        if (delay === null) throw err;
        await this.sleep(delay);
      }
    }
  }

  private retryDelay(err: InstagramApiError & { retryAfterMs?: number }, attempt: number): number | null {
    if (!err.retryable || attempt > this.maxRetries) return null;
    if (err.classification === "rate_limit") {
      // App/user call-count limits are per rolling hour/24h; a short wait only helps when the
      // server tells us so. Retry once, only if Retry-After is short; otherwise surface the error.
      if (attempt > 1 || err.retryAfterMs === undefined || err.retryAfterMs > 60_000) return null;
      return err.retryAfterMs;
    }
    const base = 500 * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * 250);
  }

  private async once<T>(url: string, endpoint: string): Promise<T> {
    this.requestCount++;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new InstagramApiError({
        message: `network error calling ${endpoint}: ${(err as Error).message}${
          (err as { cause?: { code?: string } }).cause?.code ? ` (${(err as { cause: { code: string } }).cause.code})` : ""
        }`,
        classification: "network",
        endpoint,
      });
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const errBody = extractErrorBody(body);
    if (!res.ok || errBody) {
      const e = new InstagramApiError({
        message: errBody?.message ?? `HTTP ${res.status} from ${endpoint}`,
        classification: classifyGraphError(res.status, errBody),
        endpoint,
        httpStatus: res.status,
        code: errBody?.code ?? null,
        subcode: errBody?.error_subcode ?? null,
        type: errBody?.type ?? null,
        fbtraceId: errBody?.fbtrace_id ?? null,
      }) as InstagramApiError & { retryAfterMs?: number };
      const ra = res.headers.get("retry-after");
      if (ra && /^\d+$/.test(ra)) e.retryAfterMs = Number(ra) * 1000;
      throw e;
    }
    if (body === undefined || typeof body !== "object" || body === null) {
      throw new InstagramApiError({
        message: `non-JSON response from ${endpoint}`,
        classification: "invalid_response",
        endpoint,
        httpStatus: res.status,
      });
    }
    return body as T;
  }

  // ---------------------------------------------------------------------------------------------
  // Endpoints
  // ---------------------------------------------------------------------------------------------

  /** GET /me. With Instagram Login, `user_id` is the professional account ID, `id` is app-scoped. */
  async getMe(fields: readonly string[]): Promise<IgMe> {
    const body = await this.getJson<IgMe | { data?: IgMe[] }>(
      this.buildUrl("me", { fields: fields.join(",") }),
    );
    // The get-started guide shows the response wrapped in `data: [...]`; the node itself is
    // returned unwrapped in practice. Accept both.
    if ("data" in body && Array.isArray(body.data)) return body.data[0] ?? {};
    return body as IgMe;
  }

  /**
   * Pages through GET /<IG_ID>/media (most recent first; Meta: "Returns a maximum of 10K of the
   * most recently created media"; stories are not included).
   */
  async *iterateMedia(igUserId: string, fields: readonly string[], pageSize = 50): AsyncGenerator<IgMediaNode[]> {
    let url: string | undefined = this.buildUrl(`${igUserId}/media`, {
      fields: fields.join(","),
      limit: pageSize,
    });
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url)) break; // defensive: never loop on a repeated cursor
      seen.add(url);
      const page: Paged<IgMediaNode> = await this.getJson<Paged<IgMediaNode>>(url);
      const items = Array.isArray(page.data) ? page.data.filter((m) => typeof m?.id === "string") : [];
      if (items.length) yield items;
      url = page.paging?.next ? this.sanitiseNextUrl(page.paging.next) : undefined;
    }
  }

  /** Follow a `paging.next` URL only on our own host, and never forward a token found in it. */
  private sanitiseNextUrl(next: string): string {
    const u = new URL(next);
    const base = new URL(this.baseUrl);
    if (u.host !== base.host || u.protocol !== base.protocol) {
      throw new InstagramApiError({
        message: `refusing to follow paging URL on unexpected host ${u.host}`,
        classification: "invalid_response",
        endpoint: safeEndpoint(next),
      });
    }
    u.searchParams.delete("access_token");
    return u.toString();
  }

  /**
   * GET /<MEDIA_ID>/insights?metric=a,b,c. Returns one InsightValue per requested metric.
   * Throws InstagramApiError when the request as a whole fails (callers isolate metrics by
   * retrying them one at a time).
   */
  async getMediaInsights(mediaId: string, metrics: readonly string[]): Promise<Map<string, InsightValue>> {
    const body = await this.getJson<{ data?: unknown[] }>(
      this.buildUrl(`${mediaId}/insights`, { metric: metrics.join(",") }),
    );
    return parseInsightTotals(body, metrics);
  }

  /**
   * GET /<IG_ID>/insights?metric=<metric>&period=<period>&since&until (time series).
   * Used for `follower_count` (period=day): NEW followers per day, not a net count.
   */
  async getUserInsightSeries(
    igUserId: string,
    metric: string,
    period: string,
    since: Date,
    until: Date,
  ): Promise<UserInsightPoint[] | null> {
    const body = await this.getJson<{ data?: unknown[] }>(
      this.buildUrl(`${igUserId}/insights`, {
        metric,
        period,
        since: Math.floor(since.getTime() / 1000),
        until: Math.floor(until.getTime() / 1000),
      }),
    );
    const entry = findMetric(body, metric);
    if (!entry) return null; // Meta: "returns an empty data set instead of 0"
    const values = (entry as { values?: unknown }).values;
    if (!Array.isArray(values)) return [];
    const out: UserInsightPoint[] = [];
    for (const v of values) {
      const endTimeRaw = (v as { end_time?: unknown })?.end_time;
      if (typeof endTimeRaw !== "string") continue;
      const endTime = new Date(endTimeRaw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
      if (Number.isNaN(endTime.getTime())) continue;
      out.push({ endTime, value: readNumber((v as { value?: unknown }).value) });
    }
    return out;
  }

  /**
   * GET /refresh_access_token?grant_type=ig_refresh_token. The token being refreshed is sent in
   * the Authorization header (Meta's example puts it in the query string; see README "Unverified").
   */
  async refreshLongLivedToken(): Promise<{ accessToken: string; expiresIn: number | null }> {
    const body = await this.getJson<{ access_token?: unknown; expires_in?: unknown }>(
      this.buildUrl("refresh_access_token", { grant_type: "ig_refresh_token" }, false),
    );
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new InstagramApiError({
        message: "refresh_access_token response had no access_token",
        classification: "invalid_response",
        endpoint: "graph.instagram.com/refresh_access_token",
      });
    }
    return {
      accessToken: body.access_token,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    };
  }
}

// -----------------------------------------------------------------------------------------------
// Response parsing helpers
// -----------------------------------------------------------------------------------------------

function extractErrorBody(body: unknown): GraphErrorBody | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { error?: unknown; error_type?: unknown; error_message?: unknown; code?: unknown };
  if (b.error && typeof b.error === "object") return b.error as GraphErrorBody;
  // api.instagram.com OAuth errors use a flat shape: {error_type, code, error_message}
  if (typeof b.error_message === "string") {
    return {
      message: b.error_message,
      type: typeof b.error_type === "string" ? b.error_type : undefined,
      code: typeof b.code === "number" ? b.code : undefined,
    };
  }
  return undefined;
}

function findMetric(body: { data?: unknown[] }, metric: string): unknown {
  if (!Array.isArray(body.data)) return undefined;
  return body.data.find((d) => (d as { name?: unknown })?.name === metric);
}

export function readNumber(v: unknown): InsightValue {
  if (typeof v === "number" && Number.isFinite(v)) return { kind: "value", value: v };
  if (v === undefined || v === null) return { kind: "absent", reason: "API returned no value" };
  return { kind: "invalid", reason: `API returned a non-numeric value (${typeof v})` };
}

export function parseInsightTotals(body: { data?: unknown[] }, metrics: readonly string[]): Map<string, InsightValue> {
  const out = new Map<string, InsightValue>();
  for (const metric of metrics) {
    const entry = findMetric(body, metric) as
      | { values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } }
      | undefined;
    if (!entry) {
      out.set(metric, {
        kind: "absent",
        reason: "API returned an empty data set for this metric (Meta: data does not exist or is currently unavailable)",
      });
      continue;
    }
    const raw = entry.total_value?.value ?? entry.values?.[0]?.value;
    out.set(metric, readNumber(raw));
  }
  return out;
}
