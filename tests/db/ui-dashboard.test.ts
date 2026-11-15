/** Dashboard payload against the real local Postgres. All rows are SYNTHETIC. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { GoalConfig } from "../../src/lib/config";
import { loadDashboard } from "../../src/lib/queries/ui/dashboard";
import { getAccountInfo } from "../../src/lib/queries/ui/account";
import { insertAccount, insertSnapshot } from "../helpers/seed";
import { closeTestPool, resetDb, testPool } from "../helpers/test-db";

const db = testPool();
const goal: GoalConfig = { followers: 100_000, deadline: "2026-12-31", timezone: "America/New_York" };
const now = new Date("2026-11-15T17:00:00Z");

beforeEach(() => resetDb(db));
afterAll(closeTestPool);

describe("UI account lookup", () => {
  it("is Unavailable when no account is pinned, even if an ig_accounts row exists", async () => {
    await insertAccount(db, "synthetic-ig-1", "synthetic_user", false);
    const a = await getAccountInfo(db, now);
    expect(a.status).not.toBe("available");
  });
  it("uses the pinned account, not the most recently updated ig_accounts row", async () => {
    await insertAccount(db, "synthetic-ig-1", "pinned_user");
    await insertAccount(db, "synthetic-ig-2", "other_user", false);
    await db.query("UPDATE ig_accounts SET updated_at = now() + interval '1 hour' WHERE ig_user_id = 'synthetic-ig-2'");
    const a = await getAccountInfo(db, now);
    expect(a.status === "available" && a.value.username).toBe("pinned_user");
  });
});

describe("loadDashboard", () => {
  it("carries yesterday's net growth with both snapshots and the stale flag", async () => {
    const acct = await insertAccount(db);
    await insertSnapshot(db, acct, "2026-11-14T05:00:00Z", 1000);
    await insertSnapshot(db, acct, "2026-11-15T04:55:00Z", 1012);
    await insertSnapshot(db, acct, "2026-11-15T01:00:00Z", 1010);
    const d = await loadDashboard(db, now, goal);
    expect(d.yesterdayDate).toBe("2026-11-14");
    expect(d.yesterday.status).toBe("available");
    if (d.yesterday.status === "available") expect(d.yesterday.value.delta).toBe(12);
    expect(d.current.stale).toBe(true);
  });
  it("yesterday is Unavailable on an empty database", async () => {
    const d = await loadDashboard(db, now, goal);
    expect(d.yesterday.status).not.toBe("available");
    expect(d.current.status).not.toBe("available");
  });
});
