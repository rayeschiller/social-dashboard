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
  FOLLOWER_SNAPSHOT_STALE_HOURS,
  followerHistory,
  followerHistoryDaily,
  netGrowth,
  netGrowthForLocalDay,
  newFollowersDaily,
  previousLocalDate,
  remainingTo100k,
  requiredDailyPace,
  snapshotAge,
  windowStart,
  type CurrentFollowers,
  type DailyFollowerPoint,
  type LocalDayNetGrowth,
  type SnapshotAge,
  type GrowthPeriod,
  type NetGrowth,
  type NewFollowersPoint,
  type QueryOptions,
  type RequiredPace,
  type SnapshotHistoryPoint,
  type SnapshotPoint,
} from "./followers";
export { mediaWithLatestMetrics, type LastAvailable, type MediaMetric, type MediaWithMetrics } from "./media";
export { getPinnedAccount, getPinnedAccountId, type PinnedAccount } from "../account/tracked";
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
