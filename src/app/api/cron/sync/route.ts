import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { hasBearerSecret } from "@/lib/http";
import { createSyncContext, runSyncJob, SYNC_JOBS, type SyncJob } from "@/lib/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron entry point. Vercel sends "Authorization: Bearer $CRON_SECRET".
 * ?job=account | media | token | all (default all). See vercel.json for schedules.
 */
export async function GET(req: NextRequest) {
  if (!hasBearerSecret(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const job = (req.nextUrl.searchParams.get("job") ?? "all") as SyncJob;
  if (!SYNC_JOBS.includes(job)) {
    return NextResponse.json({ error: `job must be one of ${SYNC_JOBS.join(", ")}` }, { status: 400 });
  }
  const db = getPool();
  const ctx = await createSyncContext(db, "cron");
  const runs = await runSyncJob(ctx, job);
  const failed = runs.some((r) => r.status === "failed");
  return NextResponse.json(
    {
      job,
      runs: runs.map((r) => ({ id: r.id, kind: r.kind, status: r.status, errorCode: r.errorCode ?? null, errorMessage: r.errorMessage ?? null })),
    },
    { status: failed ? 502 : 200 },
  );
}
