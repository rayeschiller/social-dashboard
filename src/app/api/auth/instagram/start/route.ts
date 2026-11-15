import { NextResponse } from "next/server";
import { getInstagramConfig } from "@/lib/config";
import { buildAuthorizeUrl, newOAuthState, OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE_SECONDS } from "@/lib/instagram/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts Business Login for Instagram. A random `state` is stored in an httpOnly cookie (CSRF). */
export async function GET() {
  const cfg = getInstagramConfig();
  if (!cfg.appId || !cfg.redirectUri) {
    return NextResponse.json({ error: "IG_APP_ID and IG_REDIRECT_URI must be configured" }, { status: 500 });
  }
  const state = newOAuthState();
  const res = NextResponse.redirect(buildAuthorizeUrl(cfg, state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: cfg.redirectUri.startsWith("https://"),
    sameSite: "lax",
    path: "/api/auth/instagram",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return res;
}
