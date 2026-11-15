/**
 * Access gate (Next.js 16 "proxy", formerly middleware; runs on the Node.js runtime).
 *
 * Every page and API route needs a valid session cookie, except the PUBLIC_PATHS in
 * src/lib/auth/session.ts: the login form and its POST handler, /api/cron/sync (CRON_SECRET)
 * and the Instagram OAuth callback (state cookie). Without DASHBOARD_PASSWORD the gate fails
 * closed (503); DASHBOARD_AUTH=disabled turns it off only outside production.
 */
import { NextResponse, type NextRequest } from "next/server";
import { checkAccess, isPublicPath, SESSION_COOKIE } from "./lib/auth/session";

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const decision = checkAccess(req.cookies.get(SESSION_COOKIE)?.value);
  if (decision.ok) return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  if (decision.status === 503) {
    return isApi
      ? NextResponse.json({ error: decision.reason }, { status: 503 })
      : new NextResponse(decision.reason, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (isApi) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const login = new URL("/login", req.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
