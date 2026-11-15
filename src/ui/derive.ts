/**
 * Derived values for the UI. Each derived figure is a Provenanced value that is `available`
 * only when every input is available; otherwise it carries a reason and renders "Unavailable".
 * Nothing is estimated, defaulted to 0, or extrapolated.
 */
import { available, isAvailable, notAvailable, SOURCES, type Provenanced } from "../lib/provenance";
import type { NetGrowth } from "../lib/queries/followers";

const latest = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/** Follows per 1,000 views. Only when BOTH follows and views are available and views > 0. */
export function followsPer1000Views(follows: Provenanced<number>, views: Provenanced<number>): Provenanced<number> {
  if (!isAvailable(follows)) return notAvailable("unavailable", `Follows unavailable: ${follows.reason}`);
  if (!isAvailable(views)) return notAvailable("unavailable", `Views unavailable: ${views.reason}`);
  if (views.value <= 0) return notAvailable("unavailable", "Views is 0, so a per-view rate is undefined");
  return available((follows.value / views.value) * 1000, SOURCES.derived, latest(follows.retrievedAt, views.retrievedAt));
}

/** Follows as a percentage of views. Same availability rule as followsPer1000Views. */
export function followConversionPct(follows: Provenanced<number>, views: Provenanced<number>): Provenanced<number> {
  const per1000 = followsPer1000Views(follows, views);
  if (!isAvailable(per1000)) return per1000;
  return available(per1000.value / 10, SOURCES.derived, per1000.retrievedAt);
}

/**
 * Average net followers per day between the two real snapshots a net-growth window was computed
 * from. A historical average, not a forecast.
 */
export function averageDailyNet(net: Provenanced<NetGrowth>): Provenanced<number> {
  if (!isAvailable(net)) return net;
  const days = (net.value.end.retrievedAt.getTime() - net.value.start.retrievedAt.getTime()) / 86_400_000;
  if (!(days > 0)) return notAvailable("unavailable", "The two snapshots are at the same instant, so no rate can be computed");
  return available(net.value.delta / days, SOURCES.derived, net.retrievedAt);
}

/** actual - required (per day). Available only when both are. */
export function paceGap(actual: Provenanced<number>, required: Provenanced<number>): Provenanced<number> {
  if (!isAvailable(actual)) return notAvailable("unavailable", `Actual pace unavailable: ${actual.reason}`);
  if (!isAvailable(required)) return notAvailable("unavailable", `Required pace unavailable: ${required.reason}`);
  return available(actual.value - required.value, SOURCES.derived, latest(actual.retrievedAt, required.retrievedAt));
}

/** Followers / goal as a percentage, from the latest snapshot. */
export function progressPct(current: Provenanced<number>, goal: number): Provenanced<number> {
  if (!isAvailable(current)) return current;
  return available((current.value / goal) * 100, SOURCES.derived, current.retrievedAt, { syncRunId: current.syncRunId });
}
