import { NextResponse, type NextRequest } from "next/server";
import { checkAccess, SESSION_COOKIE } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import { recentErrors, syncStatus } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Operational status: last run / last success per sync kind, recent runs and API errors. No secrets. */
export async function GET(req: NextRequest) {
  // Also enforced by src/proxy.ts; checked here too so the route never depends on the matcher alone.
  const access = checkAccess(req.cookies.get(SESSION_COOKIE)?.value);
  if (!access.ok) return NextResponse.json({ error: access.status === 401 ? "unauthorized" : access.reason }, { status: access.status });
  const db = getPool();
  const [status, errors] = await Promise.all([syncStatus(db), recentErrors(db, 20)]);
  return NextResponse.json({ ...status, recentErrors: errors.value });
}
