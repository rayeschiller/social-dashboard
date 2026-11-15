/**
 * Composes the existing query-layer functions into the single payload the home page renders.
 * Adds no new SQL beyond getAccountInfo; no values are computed here except the date window.
 */
import { getGoalConfig, type GoalConfig } from "../../config";
import type { Queryable } from "../../db";
import { addDays, formatLocalDate, localDate } from "../../time";
import {
  currentFollowers,
  daysRemaining,
  followerHistoryDaily,
  netGrowth,
  netGrowthForLocalDay,
  newFollowersDaily,
  previousLocalDate,
  remainingTo100k,
  requiredDailyPace,
  type GrowthPeriod,
} from "../followers";
import { mediaWithLatestMetrics } from "../media";
import { lastSuccessfulSync, recentErrors } from "../sync";
import { getAccountInfo } from "./account";
import { getPinnedAccountId } from "../../account/tracked";

export const HISTORY_DAYS = 30;
export const POST_LIMIT = 100;

export async function loadDashboard(db: Queryable, now: Date = new Date(), goal: GoalConfig = getGoalConfig()) {
  const account = await getAccountInfo(db, now);
  // The pinned tracked account, never "the most recently updated ig_accounts row". Passed
  // explicitly so every query in this payload reads the same account.
  const igUserId = (await getPinnedAccountId(db)) ?? undefined;
  const o = { db, now, goal, igUserId };

  const today = localDate(now, goal.timezone);
  const fromDate = formatLocalDate(addDays(today, -(HISTORY_DAYS - 1)));
  const periods: GrowthPeriod[] = ["day", "week", "month"];

  const yesterdayDate = previousLocalDate(now, goal.timezone);

  const [current, yesterday, remaining, pace, growth, history, newFollowers, media, lastSync, errors] = await Promise.all([
    currentFollowers(o),
    netGrowthForLocalDay(yesterdayDate, o),
    remainingTo100k(o),
    requiredDailyPace(o),
    Promise.all(periods.map((p) => netGrowth(p, o))),
    followerHistoryDaily({ ...o, fromDate }),
    newFollowersDaily({ ...o, from: new Date(now.getTime() - HISTORY_DAYS * 86_400_000), to: now }),
    mediaWithLatestMetrics({ db, igUserId, limit: POST_LIMIT }),
    lastSuccessfulSync(db),
    recentErrors(db, 5),
  ]);

  return {
    goal,
    now,
    account,
    current,
    yesterday,
    yesterdayDate,
    remaining,
    pace,
    days: daysRemaining(now, goal),
    growth: { day: growth[0]!, week: growth[1]!, month: growth[2]! },
    history,
    newFollowers,
    media,
    lastSync,
    errors,
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;
