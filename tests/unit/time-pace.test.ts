import { describe, expect, it } from "vitest";
import type { GoalConfig } from "../../src/lib/config";
import { daysRemaining, windowStart } from "../../src/lib/queries/followers";

const goalNY: GoalConfig = { followers: 100_000, deadline: "2026-12-31", timezone: "America/New_York" };
const goalUTC: GoalConfig = { ...goalNY, timezone: "UTC" };

describe("daysRemaining (inclusive of today, through the deadline, in the reporting timezone)", () => {
  it("counts today and the deadline day", () => {
    // 2026-11-15 (NY): 16 days left in November + 31 in December
    expect(daysRemaining(new Date("2026-11-15T17:00:00Z"), goalNY).value).toBe(47);
  });

  it("is 1 on the deadline day and 0 after it", () => {
    expect(daysRemaining(new Date("2026-12-31T23:59:00-05:00"), goalNY).value).toBe(1);
    expect(daysRemaining(new Date("2027-01-01T00:00:01-05:00"), goalNY).value).toBe(0);
    expect(daysRemaining(new Date("2027-06-01T00:00:00Z"), goalNY).value).toBe(0);
  });

  it("depends on the configured timezone", () => {
    const instant = new Date("2026-12-31T03:00:00Z"); // Dec 30 22:00 in New York, Dec 31 in UTC
    expect(daysRemaining(instant, goalNY).value).toBe(2);
    expect(daysRemaining(instant, goalUTC).value).toBe(1);
  });
});

describe("windowStart", () => {
  const tz = "America/New_York";
  it("day starts at local midnight (EST)", () => {
    expect(windowStart("day", new Date("2026-11-15T17:00:00Z"), tz).toISOString()).toBe("2026-11-15T05:00:00.000Z");
  });
  it("day starts at local midnight (EDT)", () => {
    expect(windowStart("day", new Date("2026-07-04T12:00:00Z"), tz).toISOString()).toBe("2026-07-04T04:00:00.000Z");
  });
  it("handles the DST change day (2026-11-01 starts in EDT)", () => {
    expect(windowStart("day", new Date("2026-11-01T20:00:00Z"), tz).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
  it("week starts Monday 00:00 local", () => {
    // 2026-11-15 is a Sunday -> Monday 2026-11-09
    expect(windowStart("week", new Date("2026-11-15T17:00:00Z"), tz).toISOString()).toBe("2026-11-09T05:00:00.000Z");
    // a Monday maps to itself
    expect(windowStart("week", new Date("2026-11-16T17:00:00Z"), tz).toISOString()).toBe("2026-11-16T05:00:00.000Z");
  });
  it("month starts on the 1st 00:00 local, across the DST change", () => {
    expect(windowStart("month", new Date("2026-11-15T17:00:00Z"), tz).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
  it("just after local midnight belongs to the new day; just before belongs to the old one", () => {
    expect(windowStart("day", new Date("2026-11-16T05:00:01Z"), tz).toISOString()).toBe("2026-11-16T05:00:00.000Z");
    expect(windowStart("day", new Date("2026-11-16T04:59:59Z"), tz).toISOString()).toBe("2026-11-15T05:00:00.000Z");
  });
});
