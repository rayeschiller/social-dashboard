# Growth dashboard: @rayeschiller

Tracks the Instagram follower count towards 100,000 by 2026-12-31 and keeps per-post metric
history. Phase 1 has the data model, the Instagram API client, the sync engine, the query layer
and the API routes. The dashboard UI comes later and is built on `src/lib/queries`.

Stack: Next.js 16 (App Router) + TypeScript (strict), PostgreSQL 16 through `pg` with plain SQL
migrations, and Vitest. It deploys to Vercel, which runs the cron jobs.

## Local setup (from a clean checkout)

Requirements: Node 22.21 or newer, npm, and PostgreSQL 16.

```bash
# 1. Start Postgres (pick whichever works on your machine)
sudo pg_ctlcluster 16 main start        # or: sudo service postgresql start

# 2. Create a role and two databases: dev, plus a test database the tests truncate
sudo -u postgres psql <<'SQL'
CREATE ROLE social_dashboard LOGIN PASSWORD 'social_dashboard_dev' CREATEDB;
CREATE DATABASE social_dashboard OWNER social_dashboard;
CREATE DATABASE social_dashboard_test OWNER social_dashboard;
SQL

# 3. Configure
cp .env.example .env.local
#    then fill in TOKEN_ENCRYPTION_KEY (openssl rand -base64 32) and CRON_SECRET (openssl rand -hex 24)

# 4. Install, migrate, check
npm ci
npm run migrate          # dev database (DATABASE_URL)
npm run typecheck
npm run lint
npm test                 # migrates TEST_DATABASE_URL itself, then runs every test
npm run build
```

| Command | What it does |
|---|---|
| `npm run migrate` | Applies `migrations/*.sql` to `DATABASE_URL` in order. Each file is checksummed, so editing an applied migration is an error. `npm run migrate:test` does the same for `TEST_DATABASE_URL`. |
| `npm run sync [-- account\|media\|token\|all]` | Runs sync jobs from the CLI. Prints run IDs and statuses. Exits with 1 if any run failed. |
| `npm test` | Runs Vitest against the real local Postgres in `TEST_DATABASE_URL`. That database's name must contain "test" and must differ from `DATABASE_URL`. |

`npm run sync` and `npm test` set `NODE_USE_ENV_PROXY=1` so that Node's `fetch` uses
`HTTPS_PROXY` in proxied environments. This setting has no effect where no proxy is configured.

With no valid token, `npm run sync` records a **failed** `sync_runs` row with the API's error,
for example `ig_190 Invalid OAuth access token`. It writes nothing to the snapshot or observation
tables.

## Instagram authentication

The app uses the Instagram API with Instagram Login on host `graph.instagram.com` (Meta app
"RayeSchillerInsights"). The client **always** sends the token as `Authorization: Bearer <token>`
and never as the `access_token` query parameter. Tokens never reach URLs, logs, error rows or
the database in plain text.

`IG_AUTH_MODE` selects where the token comes from:

| Mode | Token source |
|---|---|
| `auto` (default) | `IG_ACCESS_TOKEN` if set, otherwise the newest stored OAuth token, otherwise the run fails with `no_token` |
| `db` | The encrypted token saved by the OAuth flow. Refreshed by the `token` job. |
| `env` | `IG_ACCESS_TOKEN` |
| `proxy` | An outbound proxy injects the real `Authorization` header. The client sends the placeholder `proxy-injected`. Used in the Claude Code dev environment. |

The OAuth flow:

1. `GET /api/auth/instagram/start` sets a random `state` cookie (httpOnly, 10 minutes, scoped
   to `/api/auth/instagram`). It then redirects to `https://www.instagram.com/oauth/authorize` with
   the exact `IG_REDIRECT_URI` and the scopes `instagram_business_basic,instagram_business_manage_insights`.
2. `GET /api/auth/instagram/callback` compares `state` with the cookie in constant time and strips
   the `#_` suffix from the code. It exchanges the code for a short-lived token, then exchanges
   that for a 60-day long-lived token. It checks `/me` and refuses any account other than
   `IG_EXPECTED_USERNAME`. The accepted token is stored with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`,
   with the account ID as additional authenticated data), and the connection is written to
   `audit_log`.
3. The `token` cron job refreshes a stored token through `GET /refresh_access_token` when the token
   is at least 24 hours old and has fewer than 30 days left. Each refresh is stored as a new row,
   and the previous row gets `superseded_at`.

## Cron (vercel.json)

| Path | Schedule (UTC) | Runs |
|---|---|---|
| `/api/cron/sync?job=account` | `7 */4 * * *` (every 4 hours) | `followers_count` snapshot, then the `follower_count` daily insight (30-day backfill) |
| `/api/cron/sync?job=media` | `23 10,22 * * *` (twice a day) | Full media list (backfills everything on the first run), then per-media insights |
| `/api/cron/sync?job=token` | `41 7 * * *` | Token refresh (only when `IG_AUTH_MODE=db`) |

The route requires `Authorization: Bearer $CRON_SECRET`, which Vercel sends automatically.
Sub-daily schedules need a Vercel Pro plan; the Hobby plan runs crons at most once a day.
`GET /api/sync/status` returns the last run and the last success for each job, recent runs, and
recent API errors.

## Data rules (enforced in code and schema)

1. **Followers come only from the IG User `followers_count` field.** Each successful
   `GET /me?fields=followers_count,...` appends one row to `account_snapshots`. When the call
   fails, no row is written. The failure is recorded in `sync_runs` and `api_errors`.
2. **Per-post follows come only from the `follows` media insight.** Meta's docs list `follows`
   (and `profile_visits` and `profile_activity`) for FEED and STORY only. For REELS these are
   stored as `unsupported` without calling the API. They are never computed from account growth,
   views, reach or profile visits.
3. **A missing value is `NULL` with a status, never 0.** Statuses are `available`,
   `unavailable` (the API returned nothing), `unsupported`, `error` and `pending`. A real 0 from
   the API is stored as 0 with status `available`. CHECK constraints enforce
   `status = 'available' <=> value IS NOT NULL`.
4. **Observations are append-only.** Every row carries `source`, `retrieved_at`, a status and
   `sync_run_id`. Triggers reject `UPDATE` and `DELETE` on `account_snapshots`,
   `account_insight_observations`, `media_metric_observations` and `audit_log`. A gap between
   snapshots stays a gap.
5. **`follower_count` (daily insight) means new followers per day.** It is stored in
   `account_insight_observations` and is never used in net-change maths. A day is appended only
   when its value differs from the latest stored value for that day, so re-running the sync
   writes nothing.
6. **`is_platform_estimated`** copies Meta's own "Metric is estimated" label (`reach`,
   `reels_skip_rate`). The app does not make that judgement itself.
7. **No seed or sample metric data exists anywhere.** The migration inserts only the two
   reference rows in `metric_sources`. Synthetic values appear only inside `tests/`.

### Net growth boundary rule

Windows are calendar periods in `REPORTING_TIMEZONE` (default `America/New_York`). **day** starts
at local 00:00 today, **week** at Monday 00:00, and **month** at 00:00 on the 1st.

- **Baseline:** the latest *available* snapshot taken **at or before** the window start, and no
  earlier than the window start minus a tolerance. The tolerance is 6 hours for day, 24 hours for
  week and 48 hours for month, and callers can override it.
- **End:** the latest *available* snapshot taken after the window start and no later than now.
- **Net change:** end minus baseline. The result returns both snapshots, with their timestamps, IDs
  and sync run IDs.
- **When either snapshot is missing:** the result is `unavailable` with a reason. Nothing is
  interpolated or carried forward.

**Required pace** is `(goal - current) / daysRemaining`. **daysRemaining** counts calendar days in
the reporting timezone from today through `GOAL_DEADLINE`, both days included: it is 47 on
2026-11-15, 1 on 2026-12-31 and 0 after the deadline, at which point the pace is `unavailable`.
The goal and deadline come from `GOAL_FOLLOWERS` and `GOAL_DEADLINE`.

## Query layer (`src/lib/queries`)

Every function returns `Provenanced<T>`:

```ts
| { status: 'available'; value: T; source; retrievedAt; syncRunId?; isPlatformEstimated? }
| { status: 'unavailable' | 'unsupported' | 'error' | 'pending'; reason; source?; retrievedAt? }
```

A non-available result has no `value` field. `formatMetric(p)` renders every non-available
status as `"Unavailable"`.

The functions are:

- `currentFollowers`
- `netGrowth('day' | 'week' | 'month')`
- `remainingTo100k`
- `requiredDailyPace`
- `daysRemaining`
- `followerHistory` (raw snapshots)
- `followerHistoryDaily` (one entry per local day; days with no snapshot are `unavailable`)
- `newFollowersDaily` (the insight)
- `lastSuccessfulSync`
- `recentErrors`
- `syncStatus`
- `mediaWithLatestMetrics`

In `mediaWithLatestMetrics`, each metric resolves in this order:

1. The latest available value.
2. `unsupported`, when Meta's docs say the product type does not have the metric.
3. The latest non-available status.
4. `pending`.

## Layout

```
migrations/0001_core_schema.sql   schema, constraints, append-only triggers
scripts/                          migrate.ts, sync.ts (CLI)
src/lib/config.ts                 env config (goal, timezone, Instagram)
src/lib/provenance.ts             Provenanced<T>, formatMetric
src/lib/db/                       pool, transaction helper, migration runner
src/lib/instagram/                client, errors, metric registry, OAuth, auth resolution
src/lib/sync/                     runs (sync_runs + locking), account, media, token, orchestrator
src/lib/queries/                  query layer for the UI
src/lib/tokens/                   AES-256-GCM + encrypted token store
src/app/api/                      auth/instagram/{start,callback}, cron/sync, sync/status
tests/{unit,db,integration}       Vitest; db + integration tests use the real local Postgres
```

`tests/integration/instagram-live.test.ts` calls the real `graph.instagram.com` with an invalid
token. It checks that error code 190 becomes a failed `sync_runs` row and an `api_errors` row,
and that no snapshot is written. Set `SKIP_LIVE_IG_TEST=1` to skip it, for example when a proxy
injects a real token or the host cannot be reached.
