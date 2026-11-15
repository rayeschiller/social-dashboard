/**
 * Provenance types shared by storage, the query layer and the UI.
 *
 * A value is either `available` (it came from a named source at a known time) or it is not, in
 * which case it has NO value field at all, only a reason. There is no way to read a number out
 * of a non-available result, so "missing" can never silently turn into 0.
 */

export const AVAILABILITY_STATUSES = ["available", "unavailable", "unsupported", "error", "pending"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];
export type NonAvailableStatus = Exclude<AvailabilityStatus, "available">;

/** Known sources. The database column is open text with a reference table (metric_sources). */
export const SOURCES = {
  instagramGraphApi: "instagram_graph_api",
  instagramAppInsightsManual: "instagram_app_insights_manual",
  /** Computed by this app from stored observations (e.g. net growth between two snapshots). */
  derived: "derived_from_snapshots",
  /** Operational data from this app's own tables (sync runs, errors). */
  appDatabase: "app_database",
  /** Pure calendar arithmetic (e.g. days remaining). */
  calendar: "calendar",
} as const;
export type Source = (typeof SOURCES)[keyof typeof SOURCES] | (string & {});

export interface Available<T> {
  status: "available";
  value: T;
  source: Source;
  retrievedAt: Date;
  /** sync_runs.id of the run that produced the observation, when there is one. */
  syncRunId?: number;
  /** Meta's docs label this metric "estimated". Meta's label, not ours. */
  isPlatformEstimated?: boolean;
}

export interface NotAvailable {
  status: NonAvailableStatus;
  reason: string;
  source?: Source;
  retrievedAt?: Date;
  syncRunId?: number;
}

export type Provenanced<T> = Available<T> | NotAvailable;

export const UNAVAILABLE_LABEL = "Unavailable";

export function available<T>(
  value: T,
  source: Source,
  retrievedAt: Date,
  extra: { syncRunId?: number; isPlatformEstimated?: boolean } = {},
): Available<T> {
  return { status: "available", value, source, retrievedAt, ...extra };
}

export function notAvailable(
  status: NonAvailableStatus,
  reason: string,
  extra: { source?: Source; retrievedAt?: Date; syncRunId?: number } = {},
): NotAvailable {
  return { status, reason, ...extra };
}

export function isAvailable<T>(p: Provenanced<T>): p is Available<T> {
  return p.status === "available";
}

export function isAvailabilityStatus(s: string): s is AvailabilityStatus {
  return (AVAILABILITY_STATUSES as readonly string[]).includes(s);
}

const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimalFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * Render a provenanced value for display. Anything that is not `available` renders as the
 * literal string "Unavailable" (status and reason stay on the object for tooltips). A real 0
 * renders as "0".
 */
export function formatMetric<T>(p: Provenanced<T>, format?: (value: T) => string): string {
  if (p.status !== "available") return UNAVAILABLE_LABEL;
  if (format) return format(p.value);
  const v: unknown = p.value;
  if (typeof v === "number") {
    return Number.isInteger(v) ? integerFormat.format(v) : decimalFormat.format(v);
  }
  return String(v);
}

/** Format a signed delta, e.g. "+120", "-4", "0". */
export function formatSigned(n: number): string {
  if (n > 0) return `+${integerFormat.format(n)}`;
  return integerFormat.format(n);
}
