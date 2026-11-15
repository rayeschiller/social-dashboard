import Link from "next/link";
import { isAvailable, formatSigned } from "../lib/provenance";
import type { DashboardData } from "../lib/queries/ui/dashboard";
import { HISTORY_DAYS } from "../lib/queries/ui/dashboard";
import { FOLLOWER_SNAPSHOT_STALE_HOURS, type GrowthPeriod, type MediaMetric } from "../lib/queries";
import { averageDailyNet, paceGap, progressPct } from "./derive";
import { FollowerChart, NewFollowersChart } from "./Charts";
import {
  formatAgeHours,
  formatDateTime,
  formatDate,
  formatDurationMs,
  formatLocalDateShort,
  formatInt,
  lastRecordedText,
  localizeIsoTimestamps,
} from "./format";
import { Metric, Provenance } from "./Metric";
import { buildPostView, nextSort, sortParam, sortPosts, type PostView, type SortKey, type SortSpec } from "./posts";

type P = { data: DashboardData; tz: string };

const dec2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const signed2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, signDisplay: "exceptZero" });

/* ------------------------------------------------------------------ Header */

export function Header({ data, tz }: P) {
  const { account, lastSync, errors } = data;
  const connected = account.status === "available" && account.value.connection === "connected";
  const state =
    account.status !== "available"
      ? { label: "Not connected", tone: "off" }
      : account.value.connection === "connected"
        ? { label: "Connected", tone: "ok" }
        : account.value.connection === "token_expired"
          ? { label: "Token expired", tone: "warn" }
          : { label: "No stored token", tone: "warn" };
  const errs = errors.value;
  const errorCount = errs.apiErrors.length + errs.failedRuns.length;
  return (
    <header className="top">
      <div className="top-main">
        <p className="eyebrow">Instagram growth</p>
        <h1>
          <Metric p={account} tz={tz} format={(a) => `@${a.username}`} />
        </h1>
      </div>
      <div className="top-meta">
        <span className={`pill pill-${state.tone}`}>{state.label}</span>
        {!connected && (
          <a className="btn" href="/api/auth/instagram/start">
            {account.status === "available" ? "Reconnect Instagram" : "Connect Instagram"}
          </a>
        )}
        <p className="meta-line">
          Last successful sync:{" "}
          <Metric p={lastSync} tz={tz} format={(s) => formatDateTime(s.finishedAt ?? s.startedAt, tz)} />
        </p>
        <form method="post" action="/api/auth/logout" className="logout">
          <button type="submit" className="btn btn-quiet">Log out</button>
        </form>
      </div>
      {errorCount > 0 && (
        <details className="errors">
          <summary>
            {errorCount} recent sync or API {errorCount === 1 ? "problem" : "problems"}
          </summary>
          <ul className="error-list">
            {errs.failedRuns.map((r) => (
              <li key={`run-${r.id}`}>
                <time dateTime={r.startedAt.toISOString()}>{formatDateTime(r.startedAt, tz)}</time>
                <span className="err-job">{r.kind} sync ({r.status})</span>
                <span className="err-msg">
                  {[r.errorCode, r.errorMessage].filter(Boolean).join(": ") || "No error message was recorded"}
                </span>
              </li>
            ))}
            {errs.apiErrors.map((e) => (
              <li key={`err-${e.id}`}>
                <time dateTime={e.occurredAt.toISOString()}>{formatDateTime(e.occurredAt, tz)}</time>
                <span className="err-job">
                  {e.endpoint}
                  {e.metric ? ` (${e.metric})` : ""} ({e.classification})
                </span>
                <span className="err-msg">{e.message || "No error message was recorded"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </header>
  );
}

export function NotConnectedBanner({ data }: { data: DashboardData }) {
  if (data.account.status === "available") return null;
  return (
    <section className="banner" role="status">
      <h2>Instagram is not connected yet</h2>
      <p>
        No account has been connected or synced, so every figure below reads Unavailable. Nothing is estimated or
        filled in. Connect Instagram to start collecting follower snapshots and post metrics.
      </p>
      <a className="btn" href="/api/auth/instagram/start">
        Connect Instagram
      </a>
    </section>
  );
}

/* -------------------------------------------------------------------- Hero */

export function Hero({ data, tz }: P) {
  const { current, remaining, pace, days, goal } = data;
  const pct = progressPct(current, goal.followers);
  const width = isAvailable(pct) ? Math.min(100, Math.max(0, pct.value)) : 0;
  return (
    <section className="hero" aria-labelledby="hero-h">
      <h2 id="hero-h" className="label">Followers now</h2>
      <p className="hero-number">
        <Metric p={current} tz={tz} />
        <Provenance p={current} tz={tz} />
      </p>
      {isAvailable(current) && (
        <p className="as-of small">
          <span>
            as of <time dateTime={current.retrievedAt.toISOString()}>{formatDateTime(current.retrievedAt, tz)}</time>
            {current.snapshotAgeHours !== undefined && <> ({formatAgeHours(current.snapshotAgeHours)})</>}
          </span>
          {current.stale && (
            <span className="pill pill-warn chip" role="status">
              Stale: snapshot is over {FOLLOWER_SNAPSHOT_STALE_HOURS} hours old
            </span>
          )}
        </p>
      )}
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={isAvailable(pct) ? Math.round(width) : undefined}
        aria-valuetext={isAvailable(pct) ? `${dec2.format(pct.value)}% of goal` : "Unavailable"}
        aria-label={`Progress toward ${formatInt(goal.followers)} followers`}
      >
        <div className="progress-fill" style={{ width: `${width}%` }} />
      </div>
      <p className="progress-caption">
        <Metric p={pct} tz={tz} format={(v) => `${dec2.format(v)}%`} /> of {formatInt(goal.followers)} by {goal.deadline}
      </p>
      <dl className="stats">
        <div>
          <dt>Followers remaining</dt>
          <dd>
            <Metric p={remaining} tz={tz} />
            <Provenance p={remaining} tz={tz} />
          </dd>
        </div>
        <div>
          <dt>Days remaining</dt>
          <dd>
            <Metric p={days} tz={tz} note={`Counted through ${goal.deadline} inclusive, ${goal.timezone}`} />
            <Provenance p={days} tz={tz} note={`Counted through ${goal.deadline} inclusive, ${goal.timezone}`} />
          </dd>
        </div>
        <div>
          <dt>Required net followers per day</dt>
          <dd>
            <Metric p={pace} tz={tz} format={(v) => dec2.format(v.perDay)} />
            <Provenance p={pace} tz={tz} />
          </dd>
          {isAvailable(pace) && (
            <dd className="small">
              {formatInt(pace.value.remaining)} remaining ÷ {formatInt(pace.value.daysRemaining)} days
            </dd>
          )}
        </div>
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------ Net growth */

const PERIOD_LABEL: Record<GrowthPeriod, string> = { day: "Today", week: "This week", month: "This month" };

/** A not-available reason with ISO timestamps shown in the reporting timezone; the original stays in title. */
function Reason({ text, tz }: { text: string; tz: string }) {
  const friendly = localizeIsoTimestamps(text, tz);
  return <span title={text}>{friendly}</span>;
}

export function Growth({ data, tz }: P) {
  const periods: GrowthPeriod[] = ["day", "week", "month"];
  const required = isAvailable(data.pace)
    ? { ...data.pace, value: data.pace.value.perDay }
    : data.pace;
  return (
    <section aria-labelledby="growth-h">
      <h2 id="growth-h">Net follower growth</h2>
      <div className="cards">
        <article className="card">
          <h3 className="label">Yesterday ({formatLocalDateShort(data.yesterdayDate)})</h3>
          <p className="card-number">
            <Metric p={data.yesterday} tz={tz} format={(v) => formatSigned(v.delta)} />
            <Provenance p={data.yesterday} tz={tz} />
          </p>
          <p className="small">
            {isAvailable(data.yesterday) ? (
              <>
                From the snapshot at <time dateTime={data.yesterday.value.start.retrievedAt.toISOString()}>{formatDateTime(data.yesterday.value.start.retrievedAt, tz)}</time>{" "}
                to the snapshot at <time dateTime={data.yesterday.value.end.retrievedAt.toISOString()}>{formatDateTime(data.yesterday.value.end.retrievedAt, tz)}</time>
              </>
            ) : (
              <Reason text={data.yesterday.reason} tz={tz} />
            )}
          </p>
        </article>
        {periods.map((k) => {
          const g = data.growth[k];
          return (
            <article key={k} className="card">
              <h3 className="label">{PERIOD_LABEL[k]}</h3>
              <p className="card-number">
                <Metric p={g} tz={tz} format={(v) => formatSigned(v.delta)} />
                <Provenance p={g} tz={tz} />
              </p>
              <p className="small">
                {isAvailable(g) ? (
                  <>
                    Between <time dateTime={g.value.start.retrievedAt.toISOString()}>{formatDateTime(g.value.start.retrievedAt, tz)}</time>{" "}
                    and <time dateTime={g.value.end.retrievedAt.toISOString()}>{formatDateTime(g.value.end.retrievedAt, tz)}</time>
                  </>
                ) : (
                  <Reason text={g.reason} tz={tz} />
                )}
              </p>
            </article>
          );
        })}
      </div>

      <div className="pace">
        <h3>Actual vs required pace</h3>
        <p className="small">
          Actual is the average net change per day between the two snapshots shown above. Required is what the
          remaining days need from today.
        </p>
        <div className="table-wrap stack">
          <table>
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col" className="num">Actual per day</th>
                <th scope="col" className="num">Required per day</th>
                <th scope="col" className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {(["week", "month"] as const).map((k) => {
                const actual = averageDailyNet(data.growth[k]);
                const gap = paceGap(actual, required);
                return (
                  <tr key={k}>
                    <th scope="row">{PERIOD_LABEL[k]}</th>
                    <td className="num" data-label="Actual per day"><Metric p={actual} tz={tz} format={(v) => signed2.format(v)} /></td>
                    <td className="num" data-label="Required per day"><Metric p={required} tz={tz} format={(v) => dec2.format(v)} /></td>
                    <td className="num" data-label="Difference">
                      <span>
                        <Metric p={gap} tz={tz} format={(v) => signed2.format(v)} />
                        {isAvailable(gap) && <span className="small"> {gap.value >= 0 ? "ahead" : "behind"}</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- History */

export function History({ data, tz }: P) {
  const rows = [...data.history].reverse();
  return (
    <section aria-labelledby="hist-h">
      <h2 id="hist-h">Daily follower count, last {HISTORY_DAYS} days</h2>
      <p className="small">
        The last snapshot of each local day ({data.goal.timezone}). Days without a snapshot are left as gaps and are
        never filled or joined across.
      </p>
      <FollowerChart days={data.history} tz={tz} />
      <div className="table-wrap scroll-y fit">
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" className="num">Followers</th>
              <th scope="col">Snapshot taken</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.date}>
                <th scope="row">{formatLocalDateShort(d.date)}</th>
                <td className="num"><Metric p={d.followers} tz={tz} /></td>
                <td className="small">{isAvailable(d.followers) ? formatDateTime(d.followers.retrievedAt, tz) : "No snapshot"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- New followers */

export function NewFollowers({ data, tz }: P) {
  const to = data.now;
  const from = new Date(to.getTime() - HISTORY_DAYS * 86_400_000);
  return (
    <section aria-labelledby="nf-h">
      <h2 id="nf-h">New followers per day</h2>
      <p className="callout">
        New followers reported by Instagram, <strong>not a net change</strong>. Unfollows are not subtracted, so this
        will not match the change in total followers.
      </p>
      <NewFollowersChart points={data.newFollowers} from={from} to={to} tz={tz} />
      {data.newFollowers.length > 0 && (
        <p className="small">Bars rise from the chart baseline; the top label is the highest value reported in the period.</p>
      )}
      {data.newFollowers.length > 0 && (
        <details className="more">
          <summary>Show values as a table</summary>
          <div className="table-wrap scroll-y fit">
            <table>
              <thead>
                <tr>
                  <th scope="col">Period ending</th>
                  <th scope="col" className="num">New followers (reported by Instagram)</th>
                </tr>
              </thead>
              <tbody>
                {[...data.newFollowers].reverse().map((p) => (
                  <tr key={p.endTime.toISOString()}>
                    <th scope="row">{formatDateTime(p.endTime, tz)}</th>
                    <td className="num"><Metric p={p.newFollowers} tz={tz} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- Posts */

/**
 * A post metric: the main value is always the latest observation ("Unavailable" if it is not
 * available). A secondary line shows the last real reading, if any; it is display-only.
 */
function PostMetric({ m, tz, format, note }: { m: MediaMetric; tz: string; format?: (v: number) => string; note?: string }) {
  const last = lastRecordedText(m, tz, format);
  return (
    <span className="pm">
      <Metric p={m} tz={tz} format={format} note={note} />
      {last && <span className="small block last-recorded">{last}</span>}
    </span>
  );
}

const REELS_FOLLOWS_NOTE = "Instagram's API does not report follows for Reels";

function typeLabel(p: PostView): string {
  const m = p.media;
  if (m.mediaProductType === "REELS") return "Reel";
  if (m.mediaProductType === "STORY") return "Story";
  if (m.mediaType === "CAROUSEL_ALBUM") return "Carousel";
  if (m.mediaType === "IMAGE") return "Photo";
  if (m.mediaType === "VIDEO") return "Video";
  return "Unknown type";
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

interface Col {
  key: SortKey;
  label: string;
}
const COLS: Col[] = [
  { key: "views", label: "Views" },
  { key: "reach", label: "Reach" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "shares", label: "Shares" },
  { key: "saves", label: "Saves" },
  { key: "avgWatch", label: "Avg watch time" },
  { key: "totalWatch", label: "Total watch time" },
  { key: "follows", label: "Follows" },
  { key: "followsPer1k", label: "Follows per 1,000 views" },
];

function SortHeader({ col, spec, className }: { col: Col; spec: SortSpec; className?: string }) {
  const active = spec.key === col.key;
  const target = nextSort(spec, col.key);
  return (
    <th scope="col" className={className} aria-sort={active ? (spec.dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link href={`/?sort=${sortParam(target)}`} scroll={false} prefetch={false}>
        {col.label}
        {active && <span aria-hidden="true">{spec.dir === "asc" ? " ↑" : " ↓"}</span>}
      </Link>
    </th>
  );
}

export function Posts({ data, tz, spec }: P & { spec: SortSpec }) {
  const posts = sortPosts(data.media.map(buildPostView), spec);
  const dur = (ms: number) => formatDurationMs(ms);
  return (
    <section aria-labelledby="posts-h">
      <h2 id="posts-h">Posts</h2>
      <p className="small">
        Latest metric values per post. Sorted by {spec.key === "published" ? "publish date" : COLS.find((c) => c.key === spec.key)?.label}{" "}
        ({spec.dir === "desc" ? "highest or newest first" : "lowest or oldest first"}); posts where the value is Unavailable
        always come last.
      </p>
      {posts.length === 0 ? (
        <p className="empty">No posts have been synced yet.</p>
      ) : (
        <div className="table-wrap posts">
          <table>
            <thead>
              <tr>
                <SortHeader col={{ key: "published", label: "Post and publish date" }} spec={spec} />
                {COLS.map((c) => (
                  <SortHeader key={c.key} col={c} spec={spec} className="num" />
                ))}
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.media.igMediaId}>
                  <th scope="row" className="post-cell">
                    {p.media.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="thumb" src={p.media.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" width={56} height={56} />
                    ) : (
                      <span className="thumb thumb-empty" aria-hidden="true">{typeLabel(p).slice(0, 1)}</span>
                    )}
                    <span className="post-text">
                      <span className="caption">{p.media.caption ? truncate(p.media.caption, 110) : "No caption"}</span>
                      <span className="small">
                        {typeLabel(p)} · {p.media.publishedAt ? formatDate(p.media.publishedAt, tz) : "Publish date unavailable"}
                        {p.media.permalink && (
                          <>
                            {" · "}
                            <a href={p.media.permalink} target="_blank" rel="noopener noreferrer">View on Instagram</a>
                          </>
                        )}
                      </span>
                    </span>
                  </th>
                  <td className="num" data-label="Views"><PostMetric m={p.views} tz={tz} /></td>
                  <td className="num" data-label="Reach">
                    <PostMetric m={p.reach} tz={tz} />
                    {isAvailable(p.reach) && p.reach.isPlatformEstimated && (
                      <abbr className="est" title="Reach is estimated by Instagram">est.</abbr>
                    )}
                  </td>
                  <td className="num" data-label="Likes"><PostMetric m={p.likes} tz={tz} /></td>
                  <td className="num" data-label="Comments"><PostMetric m={p.comments} tz={tz} /></td>
                  <td className="num" data-label="Shares"><PostMetric m={p.shares} tz={tz} /></td>
                  <td className="num" data-label="Saves"><PostMetric m={p.saves} tz={tz} /></td>
                  <td className="num" data-label="Avg watch time"><PostMetric m={p.avgWatch} tz={tz} format={dur} /></td>
                  <td className="num" data-label="Total watch time"><PostMetric m={p.totalWatch} tz={tz} format={dur} /></td>
                  <td className="num" data-label="Follows">
                    <PostMetric m={p.follows} tz={tz} note={p.isReel ? REELS_FOLLOWS_NOTE : undefined} />
                  </td>
                  <td className="num" data-label="Follows per 1,000 views">
                    <Metric p={p.followsPer1k} tz={tz} format={(v) => dec2.format(v)} />
                    {isAvailable(p.conversionPct) && (
                      <span className="small block">
                        <Metric p={p.conversionPct} tz={tz} format={(v) => `${dec2.format(v)}% of views`} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="notes small">
        <li>{REELS_FOLLOWS_NOTE}, so Follows and Follows per 1,000 views are Unavailable for Reels.</li>
        <li>Follows per 1,000 views is computed only when both Follows and Views are available for that post.</li>
        <li>Watch times apply to Reels only. Hover or focus any value for its source, retrieval time and status.</li>
      </ul>
    </section>
  );
}

