/**
 * npm run sync                 -> job "all" (token refresh, account + insights, media + insights)
 * npm run sync -- account      -> one job: account | media | token | all
 *
 * Exit code 1 if any run failed. Run IDs and statuses are printed; tokens never are.
 */
import { closePool, getPool } from "../src/lib/db";
import { createSyncContext, runSyncJob, SYNC_JOBS, type SyncJob } from "../src/lib/sync";
import { loadEnv } from "./load-env";

loadEnv();

async function main() {
  const job = (process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "all") as SyncJob;
  if (!SYNC_JOBS.includes(job)) throw new Error(`job must be one of ${SYNC_JOBS.join(", ")}`);
  const db = getPool();
  const ctx = await createSyncContext(db, "cli");
  console.info(`sync job=${job} auth=${ctx.client?.authMode ?? "none"}`);
  const runs = await runSyncJob(ctx, job);
  for (const r of runs) {
    console.info(
      `  run #${r.id} ${r.kind.padEnd(16)} ${r.status}${r.errorCode ? `  ${r.errorCode}: ${r.errorMessage}` : ""}`,
    );
  }
  await closePool();
  if (runs.some((r) => r.status === "failed")) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error((err as Error).message);
  await closePool().catch(() => undefined);
  process.exit(1);
});
