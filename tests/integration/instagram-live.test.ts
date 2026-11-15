/**
 * Calls the REAL graph.instagram.com with a deliberately invalid token and checks the code-190
 * failure path end to end: failed sync_run, api_errors row, and NO snapshot written.
 *
 * Skip with SKIP_LIVE_IG_TEST=1 when an outbound proxy injects a real token (the placeholder
 * would be replaced and the call would succeed) or when the host is unreachable.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { InstagramClient } from "../../src/lib/instagram/client";
import { syncAccount } from "../../src/lib/sync";
import { closeTestPool, resetDb, testPool } from "../helpers/test-db";

const skip = process.env.SKIP_LIVE_IG_TEST === "1";
const db = testPool();

describe.skipIf(skip)("live graph.instagram.com error path", () => {
  beforeEach(() => resetDb(db));
  afterAll(closeTestPool);

  it("records code 190 as a failed sync and writes no snapshot", async () => {
    const client = new InstagramClient({ accessToken: "invalid-placeholder-token", authMode: "env", maxRetries: 0 });
    const run = await syncAccount({ db, client, trigger: "test" });

    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("ig_190");

    const runs = await db.query("SELECT status, error_code, error_detail, finished_at FROM sync_runs WHERE id = $1", [run.id]);
    expect(runs.rows[0]).toMatchObject({ status: "failed", error_code: "ig_190" });
    expect(runs.rows[0].finished_at).toBeInstanceOf(Date);
    expect(runs.rows[0].error_detail).toMatchObject({ classification: "auth", code: 190 });

    const errs = await db.query("SELECT endpoint, error_code, classification, message FROM api_errors WHERE sync_run_id = $1", [run.id]);
    expect(errs.rows).toHaveLength(1);
    expect(errs.rows[0]).toMatchObject({ error_code: 190, classification: "auth" });
    expect(errs.rows[0].endpoint).toMatch(/^graph\.instagram\.com\/v\d+\.\d+\/me\?/);
    expect(errs.rows[0].endpoint).not.toContain("invalid-placeholder-token");

    const snaps = await db.query("SELECT count(*)::int AS n FROM account_snapshots");
    expect(snaps.rows[0].n).toBe(0);
    const obs = await db.query("SELECT (SELECT count(*) FROM media_metric_observations) + (SELECT count(*) FROM account_insight_observations) AS n");
    expect(Number(obs.rows[0].n)).toBe(0);
  });
});
