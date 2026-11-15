/** Pure display helpers. No metric values are created here; they only format or describe them. */
import { isAvailable, UNAVAILABLE_LABEL, type Provenanced, type Source } from "../lib/provenance";

const SOURCE_LABELS: Record<string, string> = {
  instagram_graph_api: "Instagram Graph API",
  instagram_app_insights_manual: "Instagram app insights (manual entry)",
  derived_from_snapshots: "Derived from stored snapshots",
  app_database: "This app's database",
  calendar: "Calendar arithmetic",
};

export function sourceLabel(source: Source | undefined): string {
  if (!source) return "No source recorded";
  return SOURCE_LABELS[source] ?? source;
}

const intFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** Axis labels only: formats a number that is already a real, available value. */
export const formatInt = (n: number): string => intFormat.format(n);

export function formatDateTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

export function formatDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric" }).format(d);
}

/** "2026-11-15" -> "Nov 15" (pure calendar label, no timezone shift). */
export function formatLocalDateShort(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
    new Date(Date.UTC(y!, m! - 1, d!)),
  );
}

/** Milliseconds -> "12.3 s" / "4 m 05 s" / "2 h 03 m". 0 -> "0 s". */
export function formatDurationMs(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    const s = Math.round(totalSeconds * 10) / 10;
    return `${s} s`;
  }
  const t = Math.round(totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} m`;
  return `${m} m ${String(s).padStart(2, "0")} s`;
}

/** Human-readable provenance: source, retrieved-at and status/reason. Used for title attributes. */
export function provenanceText(p: Provenanced<unknown>, tz: string, extraNote?: string): string {
  const parts: string[] = [];
  if (isAvailable(p)) {
    parts.push(`Source: ${sourceLabel(p.source)}`);
    parts.push(`Retrieved: ${formatDateTime(p.retrievedAt, tz)}`);
    parts.push("Status: available");
    if (p.isPlatformEstimated) parts.push("Estimated by Instagram");
  } else {
    parts.push(`Status: ${p.status}`);
    parts.push(`Reason: ${p.reason}`);
    if (p.source) parts.push(`Source: ${sourceLabel(p.source)}`);
    if (p.retrievedAt) parts.push(`Last attempt: ${formatDateTime(p.retrievedAt, tz)}`);
  }
  if (extraNote) parts.push(extraNote);
  return parts.join(" · ");
}

export { UNAVAILABLE_LABEL };
