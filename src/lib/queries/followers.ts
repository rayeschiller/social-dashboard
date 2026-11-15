/**
 * Follower queries. Every number here is either a stored followers_count snapshot or arithmetic
 * on two actual snapshots (or one snapshot and the configured goal). Nothing is estimated,
 * interpolated or gap-filled; when the data needed is missing the result is NotAvailable with a
 * reason.
 *
 * NET-GROWTH BOUNDARY RULE
 *   Windows are calendar periods in the reporting timezone (REPORTING_TIMEZONE, default
 *   America/New_York):
 *     day   = since 00:00 today (local)
 *     week  = since 00:00 Monday of this ISO week (local)
 *     month = since 00:00 on the 1st of this month (local)
 *   baseline = the LATEST available snapshot taken AT OR BEFORE the window start, and no earlier
 *              than (window start - tolerance). Tolerance: day 6h, week 24h, month 48h.
 *   end      = the LATEST available snapshot taken AFTER the window start (and not after `now`).
 *   net      = end.followers - baseline.followers, returned with both snapshot timestamps.
 *   No baseline in the tolerance band, or no snapshot after the window start -> 'unavailable'
 *   with a reason. The delta therefore covers [baseline.retrievedAt, end.retrievedAt], which can
 *   start up to `tolerance` before the window; the UI must show both timestamps.
 *
 * SOURCE: every query here reads only rows with source = 'instagram_graph_api' (the schema also
 * enforces that since migration 0002) and reports the row's own source.
 * ACCOUNT: the pinned tracked account (tracked_account) unless `igUserId` is passed explicitly.
 */
import { getPinnedAccountId } from "../account/tracked";
import { getGoalConfig, isRealCalendarDate, type GoalConfig } from "../config";
import type { Queryable } from "../db";
import {
  available,
  notAvailable,
  SOURCES,
  type Available,
  type AvailabilityStatus,
  type Provenanced,
} from "../provenance";
import { addDays, diffDays, formatLocalDate, isoWeekday, localDate, parseLocalDate, startOfLocalDay } from "../time";

export type GrowthPeriod = "day" | "week" | "month";

export const DEFAULT_TOLERANCE_HOURS: Record<GrowthPeriod, number> = { day: 6, week: 24, month: 48 };

export interface QueryOptions {
  db: Queryable;
  /** Defaults to the pinned tracked account (tracked_account); unavailable when nothing is pinned. */
  igUserId?: string;
  now?: Date;
  goal?: GoalConfig;
}

export interface SnapshotPoint {
  snapshotId: number;
  followers: number;
  retrievedAt: Date;
  syncRunId: number;
  /** The row's own source (always 'instagram_graph_api'; optional only for type compatibility). */
  source?: string;
}

interface SnapshotRow {
  id: number;
  followers_count: number;
  retrieved_at: Date;
  sync_run_id: number;
  source: string;
}

const SNAPSHOT_COLUMNS = "id, followers_count, retrieved_at, sync_run_id, source";
/** Only the Instagram API's followers_count is a follower count. */
const API_ONLY = `source = '${SOURCES.instagramGraphApi}'`;

function toPoint(r: SnapshotRow): SnapshotPoint {
  return { snapshotId: r.id, followers: r.followers_count, retrievedAt: r.retrieved_at, syncRunId: r.sync_run_id, source: r.source };
}

async function resolveAccount(o: QueryOptions): Promise<string | null> {
  if (o.igUserId) return o.igUserId;
  return getPinnedAccountId(o.db);
}

const NO_ACCOUNT = "No Instagram account is tracked yet (the first account sync or OAuth connect pins it)";

async function latestSnapshot(
  db: Queryable,
  igUserId: string,
  atOrBefore: Date,
  notBefore: Date | null = null,
): Promise<SnapshotPoint | null> {
  const { rows } = await db.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS}
       FROM account_snapshots
      WHERE ig_user_id = $1 AND followers_count_status = 'available' AND ${API_ONLY}
        AND retrieved_at <= $2 AND ($3::timestamptz IS NULL OR retrieved_at >= $3)
      ORDER BY retrieved_at DESC, id DESC
      LIMIT 1`,
    [igUserId, atOrBefore, notBefore],
  );
  return rows[0] ? toPoint(rows[0]) : null;
}

/** A follower snapshot older than this is flagged `stale` (the account sync runs every 4 hours). */
export const FOLLOWER_SNAPSHOT_STALE_HOURS = 8;

export interface SnapshotAge {
  /** Hours between the snapshot's retrieved_at and `now` (fractional, never negative). */
  ageHours: number;
  /** True when ageHours > staleAfterHours. */
  stale: boolean;
  staleAfterHours: number;
}

/** Age / staleness of an observation retrieved at `retrievedAt`, as of `now`. */
export function snapshotAge(retrievedAt: Date, now: Date = new Date(), staleAfterHours = FOLLOWER_SNAPSHOT_STALE_HOURS): SnapshotAge {
  const ageHours = Math.max(0, (now.getTime() - retrievedAt.getTime()) / 3600_000);
  return { ageHours, stale: ageHours > staleAfterHours, staleAfterHours };
}

/**
 * currentFollowers' result: a Provenanced<number>; when available it also carries the snapshot's
 * age so the UI can show "as of N hours ago" and flag a stale figure.
 */
export type CurrentFollowers = Provenanced<number> & { snapshotAgeHours?: number; stale?: boolean };

/** Latest stored followers_count. Source: IG User `followers_count` only. */
export async function currentFollowers(o: QueryOptions & { staleAfterHours?: number }): Promise<CurrentFollowers> {
  const igUserId = await resolveAccount(o);
  if (!igUserId) return notAvailable("unavailable", NO_ACCOUNT);
  const now = o.now ?? new Date();
  const snap = await latestSnapshot(o.db, igUserId, now);
  if (!snap) return notAvailable("unavailable", "No followers_count snapshot has been recorded yet");
  const age = snapshotAge(snap.retrievedAt, now, o.staleAfterHours);
  return {
    ...available(snap.followers, snap.source ?? SOURCES.instagramGraphApi, snap.retrievedAt, { syncRunId: snap.syncRunId }),
    snapshotAgeHours: age.ageHours,
    stale: age.stale,
  };
}

export function windowStart(period: GrowthPeriod, now: Date, timezone: string): Date {
  const today = localDate(now, timezone);
  switch (period) {
    case "day":
      return startOfLocalDay(today, timezone);
    case "week":
      return startOfLocalDay(addDays(today, 1 - isoWeekday(today)), timezone);
    case "month":
      return startOfLocalDay({ year: today.year, month: today.month, day: 1 }, timezone);
  }
}

export interface NetGrowth {
  /** end.followers - start.followers (can be negative). */
  delta: number;
  start: SnapshotPoint;
  end: SnapshotPoint;
  period: GrowthPeriod;
  windowStart: Date;
  timezone: string;
  toleranceHours: number;
}

export async function netGrowth(
  period: GrowthPeriod,
  o: QueryOptions & { toleranceHours?: number },
): Promise<Provenanced<NetGrowth>> {
  const now = o.now ?? new Date();
  const goal = o.goal ?? getGoalConfig();
  const tz = goal.timezone;
  const toleranceHours = o.toleranceHours ?? DEFAULT_TOLERANCE_HOURS[period];
  const igUserId = await resolveAccount(o);
  if (!igUserId) return notAvailable("unavailable", NO_ACCOUNT);

  const ws = windowStart(period, now, tz);
  const earliest = new Date(ws.getTime() - toleranceHours * 3600_000);
  const baseline = await latestSnapshot(o.db, igUserId, ws, earliest);
  if (!baseline) {
    return notAvailable(
      "unavailable",
      `No followers_count snapshot between ${earliest.toISOString()} and the ${period} start ${ws.toISOString()} (${tz}); net change needs an actual snapshot at the start of the window`,
    );
  }
  const { rows: endRows } = await o.db.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS}
       FROM account_snapshots
      WHERE ig_user_id = $1 AND followers_count_status = 'available' AND ${API_ONLY}
        AND retrieved_at > $2 AND retrieved_at <= $3
      ORDER BY retrieved_at DESC, id DESC
      LIMIT 1`,
    [igUserId, ws, now],
  );
  if (!endRows[0]) {
    return notAvailable("unavailable", `No followers_count snapshot since the ${period} start ${ws.toISOString()} (${tz})`);
  }
  const start = baseline;
  const end = toPoint(endRows[0]);
  return available<NetGrowth>(
    { delta: end.followers - start.followers, start, end, period, windowStart: ws, timezone: tz, toleranceHours },
    SOURCES.derived,
    end.retrievedAt,
  );
}

export interface LocalDayNetGrowth {
  /** The local calendar day, YYYY-MM-DD in `timezone`. */
  date: string;
  /** end.followers - start.followers (can be negative). */
  delta: number;
  /** Latest API snapshot at or before the day's start (no earlier than start - tolerance). */
  start: SnapshotPoint;
  /** Latest API snapshot at or before the day's end (no earlier than end - tolerance). */
  end: SnapshotPoint;
  /** Local 00:00 of `date` (or the first instant of the day if midnight was skipped). */
  dayStart: Date;
  /** Local 00:00 of the next day. */
  dayEnd: Date;
  /** 24, or 23 / 25 on DST change days. */
  dayLengthHours: number;
  timezone: string;
  toleranceHours: number;
}

/** The local calendar date before `now`'s local date ("yesterday"), YYYY-MM-DD. */
export function previousLocalDate(now: Date, timezone: string): string {
  return formatLocalDate(addDays(localDate(now, timezone), -1));
}

/**
 * Net follower change over one COMPLETED local calendar day (e.g. yesterday), between the latest
 * API snapshot at-or-before the day's start and the latest API snapshot at-or-before the day's
 * end, each within `toleranceHours` (default 6) of its boundary. Unavailable if the day has not
 * ended yet or either snapshot is missing; nothing is interpolated.
 */
export async function netGrowthForLocalDay(
  date: string,
  o: QueryOptions & { toleranceHours?: number },
): Promise<Provenanced<LocalDayNetGrowth>> {
  const now = o.now ?? new Date();
  const goal = o.goal ?? getGoalConfig();
  const tz = goal.timezone;
  const toleranceHours = o.toleranceHours ?? DEFAULT_TOLERANCE_HOURS.day;
  if (!isRealCalendarDate(date)) return notAvailable("error", `Not a calendar date: ${date}`);
  const igUserId = await resolveAccount(o);
  if (!igUserId) return notAvailable("unavailable", NO_ACCOUNT);

  const d = parseLocalDate(date);
  const dayStart = startOfLocalDay(d, tz);
  const dayEnd = startOfLocalDay(addDays(d, 1), tz);
  if (dayEnd.getTime() > now.getTime()) {
    return notAvailable("unavailable", `${date} (${tz}) has not ended yet; net change is only reported for completed days`);
  }
  const tolMs = toleranceHours * 3600_000;
  const start = await latestSnapshot(o.db, igUserId, dayStart, new Date(dayStart.getTime() - tolMs));
  if (!start) {
    return notAvailable(
      "unavailable",
      `No followers_count snapshot within ${toleranceHours}h before the start of ${date} (${dayStart.toISOString()}, ${tz})`,
    );
  }
  const end = await latestSnapshot(o.db, igUserId, dayEnd, new Date(dayEnd.getTime() - tolMs));
  if (!end || end.snapshotId === start.snapshotId) {
    return notAvailable(
      "unavailable",
      `No followers_count snapshot within ${toleranceHours}h before the end of ${date} (${dayEnd.toISOString()}, ${tz})`,
    );
  }
  return available<LocalDayNetGrowth>(
    {
      date,
      delta: end.followers - start.followers,
      start,
      end,
      dayStart,
      dayEnd,
      dayLengthHours: (dayEnd.getTime() - dayStart.getTime()) / 3600_000,
      timezone: tz,
      toleranceHours,
    },
    SOURCES.derived,
    end.retrievedAt,
  );
}

/** Followers still needed to reach the goal (0 once reached). Based on the latest snapshot. */
export async function remainingTo100k(o: QueryOptions): Promise<Provenanced<number>> {
  const goal = o.goal ?? getGoalConfig();
  const current = await currentFollowers(o);
  if (current.status !== "available") return current;
  return available(Math.max(0, goal.followers - current.value), SOURCES.derived, current.retrievedAt, {
    syncRunId: current.syncRunId,
  });
}

/**
 * Calendar days left including today, through the deadline (inclusive), counted in the
 * reporting timezone. On 2026-12-31 (local) this is 1; after the deadline it is 0.
 */
export function daysRemaining(now: Date = new Date(), goal: GoalConfig = getGoalConfig()): Available<number> {
  const today = localDate(now, goal.timezone);
  const days = Math.max(0, diffDays(today, parseLocalDate(goal.deadline)) + 1);
  return available(days, SOURCES.calendar, now);
}

export interface RequiredPace {
  /** Followers per day needed from today: remaining / daysRemaining. */
  perDay: number;
  remaining: number;
  daysRemaining: number;
  current: number;
  goal: number;
  deadline: string;
  timezone: string;
  basedOnSnapshotAt: Date;
}

export async function requiredDailyPace(o: QueryOptions): Promise<Provenanced<RequiredPace>> {
  const now = o.now ?? new Date();
  const goal = o.goal ?? getGoalConfig();
  const current = await currentFollowers({ ...o, now });
  if (current.status !== "available") return current;
  const days = daysRemaining(now, goal).value;
  const remaining = Math.max(0, goal.followers - current.value);
  if (days === 0) {
    return notAvailable("unavailable", `The goal deadline ${goal.deadline} (${goal.timezone}) has passed`, {
      source: SOURCES.derived,
      retrievedAt: current.retrievedAt,
    });
  }
  return available<RequiredPace>(
    {
      perDay: remaining / days,
      remaining,
      daysRemaining: days,
      current: current.value,
      goal: goal.followers,
      deadline: goal.deadline,
      timezone: goal.timezone,
      basedOnSnapshotAt: current.retrievedAt,
    },
    SOURCES.derived,
    current.retrievedAt,
    { syncRunId: current.syncRunId },
  );
}

export interface DailyFollowerPoint {
  /** Local date (reporting timezone), YYYY-MM-DD. */
  date: string;
  /** Last available snapshot of that local day; 'unavailable' when the day has none. */
  followers: Provenanced<number>;
}

export interface SnapshotHistoryPoint {
  snapshotId: number;
  retrievedAt: Date;
  followers: Provenanced<number>;
}

/** Every stored snapshot in [from, to], oldest first (including non-available ones). */
export async function followerHistory(
  o: QueryOptions & { from: Date; to?: Date },
): Promise<SnapshotHistoryPoint[]> {
  const igUserId = await resolveAccount(o);
  if (!igUserId) return [];
  const { rows } = await o.db.query<{
    id: number;
    followers_count: number | null;
    followers_count_status: AvailabilityStatus;
    retrieved_at: Date;
    sync_run_id: number;
    source: string;
    status_reason: string | null;
  }>(
    `SELECT id, followers_count, followers_count_status, retrieved_at, sync_run_id, source, status_reason
       FROM account_snapshots
      WHERE ig_user_id = $1 AND ${API_ONLY} AND retrieved_at >= $2 AND retrieved_at <= $3
      ORDER BY retrieved_at ASC, id ASC`,
    [igUserId, o.from, o.to ?? o.now ?? new Date()],
  );
  return rows.map((r) => ({
    snapshotId: r.id,
    retrievedAt: r.retrieved_at,
    followers:
      r.followers_count_status === "available" && r.followers_count !== null
        ? available(r.followers_count, r.source, r.retrieved_at, { syncRunId: r.sync_run_id })
        : notAvailable(r.followers_count_status === "available" ? "error" : r.followers_count_status, r.status_reason ?? "followers_count not available in this snapshot", {
            source: r.source,
            retrievedAt: r.retrieved_at,
            syncRunId: r.sync_run_id,
          }),
  }));
}

/**
 * One entry per local calendar day in [fromDate, toDate] (YYYY-MM-DD, reporting timezone): the
 * last available snapshot of that day, or 'unavailable' if none was taken. Days are never
 * filled from neighbours.
 */
export async function followerHistoryDaily(
  o: QueryOptions & { fromDate: string; toDate?: string },
): Promise<DailyFollowerPoint[]> {
  const goal = o.goal ?? getGoalConfig();
  const tz = goal.timezone;
  const now = o.now ?? new Date();
  const first = parseLocalDate(o.fromDate);
  const last = o.toDate ? parseLocalDate(o.toDate) : localDate(now, tz);
  const span = diffDays(first, last);
  if (span < 0) return [];
  const from = startOfLocalDay(first, tz);
  const to = startOfLocalDay(addDays(last, 1), tz);
  const snaps = (await followerHistory({ ...o, from, to: new Date(to.getTime() - 1) })).filter(
    (s) => s.followers.status === "available",
  );
  const lastPerDay = new Map<string, SnapshotHistoryPoint>();
  for (const s of snaps) lastPerDay.set(formatLocalDate(localDate(s.retrievedAt, tz)), s); // ascending -> last wins
  const out: DailyFollowerPoint[] = [];
  for (let i = 0; i <= span; i++) {
    const date = formatLocalDate(addDays(first, i));
    const s = lastPerDay.get(date);
    out.push({
      date,
      followers: s ? s.followers : notAvailable("unavailable", `No followers_count snapshot was recorded on ${date} (${tz})`),
    });
  }
  return out;
}

export interface NewFollowersPoint {
  /** end_time of the API's daily period. */
  endTime: Date;
  /** NEW followers that day per the follower_count insight. Not a net change. */
  newFollowers: Provenanced<number>;
}

/** follower_count (period=day) insight: latest stored observation per day, oldest first. */
export async function newFollowersDaily(o: QueryOptions & { from?: Date; to?: Date }): Promise<NewFollowersPoint[]> {
  const igUserId = await resolveAccount(o);
  if (!igUserId) return [];
  const { rows } = await o.db.query<{
    end_time: Date;
    value: number | null;
    status: AvailabilityStatus;
    source: string;
    retrieved_at: Date;
    sync_run_id: number;
    status_reason: string | null;
  }>(
    `SELECT DISTINCT ON (end_time) end_time, value, status, source, retrieved_at, sync_run_id, status_reason
       FROM account_insight_observations
      WHERE ig_user_id = $1 AND metric = 'follower_count' AND period = 'day' AND ${API_ONLY}
        AND ($2::timestamptz IS NULL OR end_time >= $2)
        AND ($3::timestamptz IS NULL OR end_time <= $3)
      ORDER BY end_time ASC, retrieved_at DESC, id DESC`,
    [igUserId, o.from ?? null, o.to ?? null],
  );
  return rows.map((r) => ({
    endTime: r.end_time,
    newFollowers:
      r.status === "available" && r.value !== null
        ? available(r.value, r.source, r.retrieved_at, { syncRunId: r.sync_run_id })
        : notAvailable(r.status === "available" ? "error" : r.status, r.status_reason ?? "not available", {
            source: r.source,
            retrievedAt: r.retrieved_at,
            syncRunId: r.sync_run_id,
          }),
  }));
}
