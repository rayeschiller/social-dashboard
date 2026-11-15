/**
 * Server-side query layer for the dashboard UI. Import only from server components / route
 * handlers (it uses node-postgres). Every function returns provenance-typed values; render them
 * with `formatMetric` from "@/lib/provenance", which prints "Unavailable" for anything that is
 * not status 'available'.
 */
export {
  currentFollowers,
  daysRemaining,
  DEFAULT_TOLERANCE_HOURS,
  followerHistory,
  followerHistoryDaily,
  netGrowth,
  newFollowersDaily,
  remainingTo100k,
  requiredDailyPace,
  windowStart,
  type DailyFollowerPoint,
  type GrowthPeriod,
  type NetGrowth,
  type NewFollowersPoint,
  type QueryOptions,
  type RequiredPace,
  type SnapshotHistoryPoint,
  type SnapshotPoint,
} from "./followers";
export { mediaWithLatestMetrics, type MediaWithMetrics } from "./media";
export {
  lastSuccessfulSync,
  recentErrors,
  syncStatus,
  type ApiErrorSummary,
  type RecentErrors,
  type SyncRunSummary,
  type SyncStatus,
} from "./sync";
export { formatMetric, formatSigned, UNAVAILABLE_LABEL } from "../provenance";
