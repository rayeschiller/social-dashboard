import { NextResponse, type NextRequest } from "next/server";
import { getInstagramConfig } from "@/lib/config";
import { getPool } from "@/lib/db";
import { completeOAuthCallback, OAuthCallbackError } from "@/lib/instagram/connect";
import { InstagramApiError } from "@/lib/instagram/errors";
import { OAUTH_STATE_COOKIE } from "@/lib/instagram/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cfg = getInstagramConfig();
  const p = req.nextUrl.searchParams;
  const home = new URL("/", cfg.redirectUri ?? req.nextUrl.origin);
  let res: NextResponse;
  try {
    const { username } = await completeOAuthCallback(getPool(), cfg, {
      code: p.get("code"),
      state: p.get("state"),
      error: p.get("error"),
      errorReason: p.get("error_reason"),
      cookieState: req.cookies.get(OAUTH_STATE_COOKIE)?.value,
    });
    home.searchParams.set("connected", username);
    res = NextResponse.redirect(home);
  } catch (err) {
    const code =
      err instanceof OAuthCallbackError ? err.code : err instanceof InstagramApiError ? `ig_${err.classification}` : "internal_error";
    // Messages are already redacted; never echo request parameters (they contain the code).
    console.error(`instagram oauth callback failed: ${code}: ${(err as Error).message}`);
    home.searchParams.set("connect_error", code);
    res = NextResponse.redirect(home);
  }
  res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth/instagram" });
  return res;
}
