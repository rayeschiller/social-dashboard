/**
 * Timezone helpers built on Intl (no dependencies). All boundaries are computed for an IANA
 * timezone, so DST transitions are handled by the platform's tz database.
 */

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export function localDateTime(instant: Date, tz: string): LocalDateTime {
  const parts = formatter(tz).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export function localDate(instant: Date, tz: string): LocalDate {
  const { year, month, day } = localDateTime(instant, tz);
  return { year, month, day };
}

export function formatLocalDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function parseLocalDate(s: string): LocalDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid date ${s}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Offset (ms) of `tz` from UTC at `instant`: local wall time minus UTC. */
function tzOffsetMs(instant: Date, tz: string): number {
  const l = localDateTime(instant, tz);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the local wall-clock time 00:00 of `d` occurs in `tz`. */
export function startOfLocalDay(d: LocalDate, tz: string): Date {
  const wall = Date.UTC(d.year, d.month - 1, d.day, 0, 0, 0);
  // Two passes converge for every real-world offset, including DST change days.
  let guess = wall - tzOffsetMs(new Date(wall), tz);
  guess = wall - tzOffsetMs(new Date(guess), tz);
  const l = localDateTime(new Date(guess), tz);
  if (l.year === d.year && l.month === d.month && l.day === d.day && l.hour === 0 && l.minute === 0 && l.second === 0) {
    return new Date(guess);
  }
  // Local midnight does not exist on this day (a DST gap at 00:00, e.g. America/Santiago in
  // September): the day starts at the first instant whose local date is `d`. Binary search for
  // it; the local date is non-decreasing across a forward gap.
  const target = Date.UTC(d.year, d.month - 1, d.day);
  const dayKey = (t: number) => {
    const x = localDate(new Date(t), tz);
    return Date.UTC(x.year, x.month - 1, x.day);
  };
  let lo = wall - 36 * 3600_000; // local date < d
  let hi = wall + 36 * 3600_000; // local date > d
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (dayKey(mid) < target) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

/** Add whole calendar days to a local date. */
export function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Whole calendar days from a to b (b - a). */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** ISO weekday 1 (Monday) .. 7 (Sunday). */
export function isoWeekday(d: LocalDate): number {
  const w = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return w === 0 ? 7 : w;
}
