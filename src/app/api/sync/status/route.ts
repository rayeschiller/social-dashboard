import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { recentErrors, syncStatus } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Operational status: last run / last success per sync kind, recent runs and API errors. No secrets. */
export async function GET() {
  const db = getPool();
  const [status, errors] = await Promise.all([syncStatus(db), recentErrors(db, 20)]);
  return NextResponse.json({ ...status, recentErrors: errors.value });
}
