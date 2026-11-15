/**
 * A scripted stand-in for graph.instagram.com, used ONLY by tests. All numbers it returns are
 * SYNTHETIC test fixtures defined inside test files; nothing here is real account data.
 */
import { InstagramClient } from "../../src/lib/instagram/client";

export interface FakeCall {
  url: URL;
  authorization: string | null;
}

export type FakeResponse = { status?: number; body: unknown; headers?: Record<string, string> };
export type Route = (url: URL, call: FakeCall) => FakeResponse | undefined;

export function fakeFetch(routes: Route[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers);
    const call = { url, authorization: headers.get("authorization") };
    calls.push(call);
    for (const r of routes) {
      const res = r(url, call);
      if (res) {
        return new Response(JSON.stringify(res.body), {
          status: res.status ?? 200,
          headers: { "content-type": "application/json", ...(res.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ error: { message: `no fake route for ${url.pathname}`, code: 100 } }), { status: 400 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export function fakeClient(routes: Route[], token = "synthetic-test-token") {
  const f = fakeFetch(routes);
  const client = new InstagramClient({
    accessToken: token,
    authMode: "env",
    fetchImpl: f.fetch,
    sleep: async () => undefined,
    maxRetries: 2,
  });
  return { client, calls: f.calls };
}

export const graphError = (code: number, message: string, status = 400, extra: Record<string, unknown> = {}): FakeResponse => ({
  status,
  body: { error: { message, type: "OAuthException", code, ...extra } },
});

/** Synthetic insights response for the given metric -> value pairs (undefined = omitted). */
export function insightsBody(values: Record<string, number | undefined>): FakeResponse {
  return {
    body: {
      data: Object.entries(values)
        .filter(([, v]) => v !== undefined)
        .map(([name, value]) => ({ name, period: "lifetime", values: [{ value }], id: `x/insights/${name}/lifetime` })),
    },
  };
}
