/** Follower query layer against the real local Postgres. All counts below are SYNTHETIC. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { GoalConfig } from "../../src/lib/config";
import {
  currentFollowers,
  followerHistoryDaily,
  netGrowth,
  remainingTo100k,
  requiredDailyPace,
} from "../../src/lib/queries";
import { formatMetric } from "../../src/lib/provenance";
import { insertAccount, insertSnapshot } from "../helpers/seed";
import { closeTestPool, resetDb, testPool } from "../helpers/test-db";

const db = testPool();
const goal: GoalConfig = { followers: 100_000, deadline: "2026-12-31", timezone: "America/New_York" };
// "Now" = Sunday 2026-11-15 12:00 in New York (17:00Z). Day window starts 2026-11-15T05:00Z.
const now = new Date("2026-11-15T17:00:00Z");
let acct: string;

beforeEach(async () => {
  await resetDb(db);
  acct = await insertAccount(db);
});
afterAll(closeTestPool);

describe("currentFollowers", () => {
  it("is Unavailable (not 0) when no snapshot exists", async () => {
    const r = await currentFollowers({ db, now });
    expect(r.status).toBe("unavailable");
    expect(formatMetric(r)).toBe("Unavailable");
  });

  it("returns a real 0 as an available 0", async () => {
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 0);
    const r = await currentFollowers({ db, now });
    expect(r).toMatchObject({ status: "available", value: 0, source: "instagram_graph_api" });
    expect(formatMetric(r)).toBe("0");
  });

  it("uses the latest AVAILABLE snapshot and exposes its timestamp; never a later failed one", async () => {
    await insertSnapshot(db, acct, "2026-11-15T08:00:00Z", 5000);
    await insertSnapshot(db, acct, "2026-11-15T12:00:00Z", null); // field missing in that run
    const r = await currentFollowers({ db, now });
    expect(r.status).toBe("available");
    if (r.status === "available") {
      expect(r.value).toBe(5000);
      expect(r.retrievedAt.toISOString()).toBe("2026-11-15T08:00:00.000Z");
      expect(typeof r.syncRunId).toBe("number");
    }
  });

  it("ignores snapshots after `now`", async () => {
    await insertSnapshot(db, acct, "2026-11-16T00:00:00Z", 6000);
    expect((await currentFollowers({ db, now })).status).toBe("unavailable");
  });
});

describe("netGrowth", () => {
  it("is end minus baseline, with both snapshot timestamps", async () => {
    await insertSnapshot(db, acct, "2026-11-15T03:00:00Z", 5000); // 22:00 local on the 14th, within 6h of midnight
    await insertSnapshot(db, acct, "2026-11-15T09:00:00Z", 5040);
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5100);
    const r = await netGrowth("day", { db, now, goal });
    expect(r.status).toBe("available");
    if (r.status !== "available") return;
    expect(r.value.delta).toBe(100);
    expect(r.value.start.retrievedAt.toISOString()).toBe("2026-11-15T03:00:00.000Z");
    expect(r.value.end.retrievedAt.toISOString()).toBe("2026-11-15T16:00:00.000Z");
    expect(r.value.windowStart.toISOString()).toBe("2026-11-15T05:00:00.000Z");
    expect(r.source).toBe("derived_from_snapshots");
  });

  it("baseline is the latest snapshot AT OR BEFORE the boundary, not the nearest after it", async () => {
    await insertSnapshot(db, acct, "2026-11-15T01:00:00Z", 4900);
    await insertSnapshot(db, acct, "2026-11-15T04:30:00Z", 4950); // latest before boundary
    await insertSnapshot(db, acct, "2026-11-15T05:00:00Z", 4960); // exactly at boundary -> baseline
    await insertSnapshot(db, acct, "2026-11-15T05:10:00Z", 4970); // after boundary: never a baseline
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5000);
    const r = await netGrowth("day", { db, now, goal });
    expect(r.status === "available" && r.value.start.followers).toBe(4960);
    expect(r.status === "available" && r.value.delta).toBe(40);
  });

  it("can be negative", async () => {
    await insertSnapshot(db, acct, "2026-11-15T04:00:00Z", 5000);
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 4990);
    const r = await netGrowth("day", { db, now, goal });
    expect(r.status === "available" && r.value.delta).toBe(-10);
  });

  it("is unavailable when there is no snapshot before the window start", async () => {
    await insertSnapshot(db, acct, "2026-11-15T06:00:00Z", 5000);
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5100);
    const r = await netGrowth("day", { db, now, goal });
    expect(r.status).toBe("unavailable");
    expect(r.status !== "available" && r.reason).toMatch(/No followers_count snapshot between/);
    expect(formatMetric(r)).toBe("Unavailable");
  });

  it("is unavailable when the only earlier snapshot is outside the tolerance (no gap-filling)", async () => {
    await insertSnapshot(db, acct, "2026-11-14T20:00:00Z", 5000); // 9h before the boundary > 6h
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5100);
    expect((await netGrowth("day", { db, now, goal })).status).toBe("unavailable");
    // ...but a caller may widen the tolerance explicitly
    const wide = await netGrowth("day", { db, now, goal, toleranceHours: 12 });
    expect(wide.status === "available" && wide.value.delta).toBe(100);
  });

  it("ignores non-available snapshots at the boundary", async () => {
    await insertSnapshot(db, acct, "2026-11-15T04:00:00Z", null);
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5100);
    expect((await netGrowth("day", { db, now, goal })).status).toBe("unavailable");
  });

  it("is unavailable when nothing was recorded since the window start", async () => {
    await insertSnapshot(db, acct, "2026-11-15T04:00:00Z", 5000);
    const r = await netGrowth("day", { db, now, goal });
    expect(r.status).toBe("unavailable");
    expect(r.status !== "available" && r.reason).toMatch(/since the day start/);
  });

  it("week and month use Monday 00:00 / the 1st 00:00 local with wider tolerances", async () => {
    await insertSnapshot(db, acct, "2026-10-31T12:00:00Z", 4000); // ~16h before Nov 1 00:00 EDT (04:00Z), within 48h
    await insertSnapshot(db, acct, "2026-11-08T20:00:00Z", 4500); // Sunday evening, 9h before Monday 05:00Z, within 24h
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5000);
    const w = await netGrowth("week", { db, now, goal });
    const m = await netGrowth("month", { db, now, goal });
    expect(w.status === "available" && w.value.delta).toBe(500);
    expect(m.status === "available" && m.value.delta).toBe(1000);
  });
});

describe("remainingTo100k and requiredDailyPace", () => {
  it("are unavailable without a snapshot", async () => {
    expect((await remainingTo100k({ db, now, goal })).status).toBe("unavailable");
    expect((await requiredDailyPace({ db, now, goal })).status).toBe("unavailable");
  });

  it("compute from the latest snapshot and days remaining (47 on 2026-11-15 NY)", async () => {
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 53_000);
    const rem = await remainingTo100k({ db, now, goal });
    expect(rem.status === "available" && rem.value).toBe(47_000);
    const pace = await requiredDailyPace({ db, now, goal });
    expect(pace.status).toBe("available");
    if (pace.status !== "available") return;
    expect(pace.value.daysRemaining).toBe(47);
    expect(pace.value.perDay).toBe(1000);
    expect(pace.value.basedOnSnapshotAt.toISOString()).toBe("2026-11-15T16:00:00.000Z");
  });

  it("is 0 once the goal is reached, and unavailable after the deadline", async () => {
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 100_500);
    const rem = await remainingTo100k({ db, now, goal });
    expect(rem).toMatchObject({ status: "available", value: 0 });
    const pace = await requiredDailyPace({ db, now, goal });
    expect(pace.status === "available" && pace.value.perDay).toBe(0);
    const late = await requiredDailyPace({ db, now: new Date("2027-01-02T12:00:00Z"), goal });
    expect(late.status).toBe("unavailable");
  });
});

describe("followerHistoryDaily", () => {
  it("returns one entry per local day and leaves days without snapshots unavailable", async () => {
    await insertSnapshot(db, acct, "2026-11-13T15:00:00Z", 4800);
    await insertSnapshot(db, acct, "2026-11-13T22:00:00Z", 4810); // last of the 13th (local)
    await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5000);
    const days = await followerHistoryDaily({ db, now, goal, fromDate: "2026-11-13", toDate: "2026-11-15" });
    expect(days.map((d) => d.date)).toEqual(["2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(days[0]!.followers).toMatchObject({ status: "available", value: 4810 });
    expect(days[1]!.followers.status).toBe("unavailable");
    expect(formatMetric(days[1]!.followers)).toBe("Unavailable");
    expect(days[2]!.followers).toMatchObject({ status: "available", value: 5000 });
  });
});

describe("schema guarantees", () => {
  it("rejects UPDATE and DELETE on snapshots (append-only)", async () => {
    const id = await insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 5000);
    await expect(db.query("UPDATE account_snapshots SET followers_count = 1 WHERE id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM account_snapshots WHERE id = $1", [id])).rejects.toThrow(/append-only/);
  });

  it("rejects 'available' without a value and a value without 'available'", async () => {
    await expect(insertSnapshot(db, acct, "2026-11-15T16:00:00Z", null, "available")).rejects.toThrow(/check constraint/);
    await expect(insertSnapshot(db, acct, "2026-11-15T16:00:00Z", 10, "unavailable")).rejects.toThrow(/check constraint/);
  });
});
