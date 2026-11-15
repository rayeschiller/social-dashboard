import { NextResponse, type NextRequest } from "next/server";
import { clientKey, loginBlockedReason, recordLoginAttempt } from "@/lib/auth/rate-limit";
import { createSessionToken, passwordMatches, safeNextPath, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { getDashboardAuthConfig } from "@/lib/config";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST form {password, next}. Sets the signed session cookie and redirects (303). */
export async function POST(req: NextRequest) {
  const cfg = getDashboardAuthConfig();
  const form = await req.formData().catch(() => null);
  const next = safeNextPath(typeof form?.get("next") === "string" ? (form!.get("next") as string) : null);
  const back = (error: string) => {
    const u = new URL("/login", req.url);
    u.searchParams.set("error", error);
    if (next !== "/") u.searchParams.set("next", next);
    return NextResponse.redirect(u, 303);
  };

  if (cfg.mode === "disabled") return NextResponse.redirect(new URL(next, req.url), 303);
  if (cfg.mode === "misconfigured") return NextResponse.json({ error: `Dashboard login is not configured: ${cfg.reason}` }, { status: 503 });

  const db = getPool();
  const client = clientKey(req.headers, cfg.sessionSecret);
  if (await loginBlockedReason(db, client)) return back("rate_limited");

  const password = form?.get("password");
  const ok = typeof password === "string" && passwordMatches(password, cfg.password);
  await recordLoginAttempt(db, client, ok);
  if (!ok) return back("invalid");

  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(SESSION_COOKIE, createSessionToken(cfg), sessionCookieOptions());
  return res;
}
