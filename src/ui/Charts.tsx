import { isAvailable } from "../lib/provenance";
import type { DailyFollowerPoint, NewFollowersPoint } from "../lib/queries";
import { paddedDomain, runs } from "./chart";
import { formatDateTime, formatInt, formatLocalDateShort, provenanceText } from "./format";

const W = 640;
const H = 220;
const PAD = { l: 64, r: 16, t: 16, b: 32 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;

export function FollowerChart({ days, tz }: { days: DailyFollowerPoint[]; tz: string }) {
  const vals = days.map((d) => (isAvailable(d.followers) ? d.followers.value : null));
  const real = vals.filter((v): v is number => v !== null);
  if (real.length === 0) {
    return <p className="empty">No follower snapshots in this period, so there is nothing to chart.</p>;
  }
  const min = Math.min(...real);
  const max = Math.max(...real);
  const [lo, hi] = paddedDomain(min, max);
  const x = (i: number) => PAD.l + (days.length === 1 ? IW / 2 : (i * IW) / (days.length - 1));
  const y = (v: number) => PAD.t + IH - ((v - lo) / (hi - lo)) * IH;
  const fmt = formatInt;
  const first = days[0]!.date;
  const last = days[days.length - 1]!.date;
  return (
    <div className="chart-wrap"><svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Daily follower count from ${first} to ${last}. Days without a snapshot are left as gaps.`}
    >
      <line className="axis" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + IH} y2={PAD.t + IH} />
      {runs(vals)
        .filter((r) => r.length > 1)
        .map((r) => (
          <polyline key={r[0]} className="line" points={r.map((i) => `${x(i)},${y(vals[i]!)}`).join(" ")} />
        ))}
      {days.map((d, i) =>
        vals[i] === null ? (
          <g key={d.date}>
            <title>{`${d.date}: Unavailable. ${provenanceText(d.followers, tz)}`}</title>
            <line className="gap" x1={x(i)} x2={x(i)} y1={PAD.t + IH - 6} y2={PAD.t + IH + 6} />
          </g>
        ) : (
          <circle key={d.date} className="dot" cx={x(i)} cy={y(vals[i]!)} r={3.5}>
            <title>{`${d.date}: ${fmt(vals[i]!)} followers. ${provenanceText(d.followers, tz)}`}</title>
          </circle>
        ),
      )}
      <text className="tick" x={PAD.l - 8} y={y(max) + 4} textAnchor="end">{fmt(max)}</text>
      {min !== max && (
        <text className="tick" x={PAD.l - 8} y={y(min) + 4} textAnchor="end">{fmt(min)}</text>
      )}
      <text className="tick" x={PAD.l} y={H - 8}>{formatLocalDateShort(first)}</text>
      <text className="tick" x={W - PAD.r} y={H - 8} textAnchor="end">{formatLocalDateShort(last)}</text>
    </svg></div>
  );
}

export function NewFollowersChart({
  points,
  from,
  to,
  tz,
}: {
  points: NewFollowersPoint[];
  from: Date;
  to: Date;
  tz: string;
}) {
  const real = points.flatMap((p) => (isAvailable(p.newFollowers) ? [p.newFollowers.value] : []));
  if (real.length === 0) {
    return <p className="empty">No follower_count insight values are stored for this period.</p>;
  }
  const max = Math.max(...real);
  const span = to.getTime() - from.getTime();
  const x = (d: Date) => PAD.l + ((d.getTime() - from.getTime()) / span) * IW;
  const h = (v: number) => (max === 0 ? 0 : (v / max) * IH);
  const barW = Math.max(3, Math.min(14, IW / 40));
  const fmt = formatInt;
  return (
    <div className="chart-wrap"><svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="New followers reported by Instagram per day, not a net change. Days without a value are left empty."
    >
      <line className="axis" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + IH} y2={PAD.t + IH} />
      {points.map((p) => {
        const cx = Math.min(W - PAD.r - barW / 2, Math.max(PAD.l + barW / 2, x(p.endTime)));
        const key = p.endTime.toISOString();
        const label = formatDateTime(p.endTime, tz);
        if (!isAvailable(p.newFollowers)) {
          return (
            <g key={key}>
              <title>{`Period ending ${label}: Unavailable. ${provenanceText(p.newFollowers, tz)}`}</title>
              <line className="gap" x1={cx} x2={cx} y1={PAD.t + IH - 6} y2={PAD.t + IH + 6} />
            </g>
          );
        }
        const bh = h(p.newFollowers.value);
        return (
          <rect key={key} className="bar" x={cx - barW / 2} y={PAD.t + IH - bh} width={barW} height={bh} rx={2}>
            <title>{`Period ending ${label}: ${fmt(p.newFollowers.value)} new followers reported by Instagram. ${provenanceText(p.newFollowers, tz)}`}</title>
          </rect>
        );
      })}
      <text className="tick" x={PAD.l - 8} y={PAD.t + 4} textAnchor="end">{fmt(max)}</text>
      <text className="tick" x={PAD.l - 8} y={PAD.t + IH + 4} textAnchor="end">0</text>
      <text className="tick" x={PAD.l} y={H - 8}>{formatDateTime(from, tz).split(",").slice(0, 2).join(",")}</text>
      <text className="tick" x={W - PAD.r} y={H - 8} textAnchor="end">{formatDateTime(to, tz).split(",").slice(0, 2).join(",")}</text>
    </svg></div>
  );
}
