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
#    then fill in TOKEN_ENCRYPTION_KEY (openssl rand -base64 32), CRON_SECRET (openssl rand -hex 24),
#    IG_EXPECTED_USERNAME (required, no default), and either DASHBOARD_PASSWORD + SESSION_SECRET
#    (openssl rand -hex 32) or, for local development only, DASHBOARD_AUTH=disabled

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
| `npm test` | Runs Vitest against the real local Postgres in `TEST_DATABASE_URL`. That database's name must contain "test" and must differ from `DATABASE_URL`. Between tests the helper empties the tables through a privileged path (it disables the append-only triggers inside one transaction, which needs table ownership); that code lives only in `tests/helpers` and refuses databases whose name lacks "test". |

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
| `auto` (default) | `IG_ACCESS_TOKEN` if set, otherwise the tracked account's stored OAuth token, otherwise the run fails with `no_token` |
| `db` | The tracked account's encrypted token saved by the OAuth flow. Refreshed by the `token` job. |
| `env` | `IG_ACCESS_TOKEN` |
| `proxy` | An outbound proxy injects the real `Authorization` header. The client sends the placeholder `proxy-injected`. Used in the Claude Code dev environment. |

The OAuth flow:

1. `GET /api/auth/instagram/start` sets a random `state` cookie (httpOnly, 10 minutes, scoped
   to `/api/auth/instagram`). It then redirects to `https://www.instagram.com/oauth/authorize` with
   the exact `IG_REDIRECT_URI` and the scopes `instagram_business_basic,instagram_business_manage_insights`.
2. `GET /api/auth/instagram/callback` compares `state` with the cookie in constant time and strips
   the `#_` suffix from the code. It exchanges the code for a short-lived token, then exchanges
   that for a 60-day long-lived token. It checks `/me` against the tracked account (see below)
   and refuses any other account. The accepted token is stored with AES-256-GCM
   (`TOKEN_ENCRYPTION_KEY`, with the account ID as additional authenticated data), and the
   connection is written to `audit_log`.
3. The `token` cron job refreshes a stored token through `GET /refresh_access_token` when the token
   is at least 24 hours old and has fewer than 30 days left. Each refresh is stored as a new row,
   and the previous row gets `superseded_at`.

### Tracked account (pinning)

The dashboard tracks exactly one account, identified by its **stable** Instagram user id
(`user_id` from `GET /me`), stored in the single-row table `tracked_account`.

- `IG_EXPECTED_USERNAME` is **required**; there is no default. Without it every sync job records
  a failed run (`config_error`) and the OAuth start/callback refuse to run.
- The first successful account sync or OAuth connect whose username equals
  `IG_EXPECTED_USERNAME` pins that account's id. Setting `IG_EXPECTED_USER_ID` pins the id up
  front instead (and must then match any existing pin, or every job fails).
- After pinning only the id is compared, so a renamed account keeps working and a different
  account that takes over the username is refused.
- A token for any other id stores nothing: the run fails with `unexpected_account` and the
  refusal is written to `audit_log`. The account, media, media-insights, account-insights and
  token-refresh jobs all check the token's account with `GET /me` first, and the token job also
  checks the refreshed token. `getActiveToken` returns only the tracked account's token, and every
  query defaults to the pinned id (never "the most recently updated `ig_accounts` row").
- The pin is immutable (triggers reject `UPDATE`, `DELETE` and `TRUNCATE`).

**Changing the tracked account** is a deliberate operator action with the migration-owner role:
`BEGIN; ALTER TABLE tracked_account DISABLE TRIGGER USER; DELETE FROM tracked_account;
ALTER TABLE tracked_account ENABLE TRIGGER USER; COMMIT;`, then update `IG_EXPECTED_USERNAME`
(and `IG_EXPECTED_USER_ID`) and reconnect. Existing history stays attached to the old id.

## Access control

All pages, `/api/sync/status` and `/api/auth/instagram/start` require a login.
`src/proxy.ts` (Next.js 16 renamed `middleware.ts` to `proxy.ts`; it runs on the Node.js runtime)
checks a session cookie, and the two API routes check it again themselves.

- `DASHBOARD_PASSWORD` is the single user's password; `SESSION_SECRET` (at least 32 characters)
  signs the cookie with HMAC-SHA256. Changing either logs everyone out.
- The cookie `sd_session` is `HttpOnly`, `Secure`, `SameSite=Lax`, valid for 7 days. Browsers
  accept `Secure` cookies on `http://localhost`, except Safari; use Chrome or Firefox locally.
- Password and signature checks are constant-time. Failed logins are rate-limited through
  `audit_log` (5 per client per 15 minutes, 50 in total per 15 minutes), so the limit holds
  across serverless instances. The client is identified by a keyed hash of the first
  `X-Forwarded-For` address, which Vercel sets; the address itself is never stored.
- Without `DASHBOARD_PASSWORD` the gate fails closed: protected routes answer 503.
  `DASHBOARD_AUTH=disabled` turns the gate off, but only when `NODE_ENV` is not `production`.
- Reachable without a login: `/login`, `POST /api/auth/login`, `POST /api/auth/logout`,
  `/api/cron/sync` (requires `CRON_SECRET`) and `/api/auth/instagram/callback` (requires the
  OAuth state cookie).

## Cron (vercel.json)

| Path | Schedule (UTC) | Runs |
|---|---|---|
| `/api/cron/sync?job=account` | `7 */4 * * *` (every 4 hours) | `followers_count` snapshot, then the `follower_count` daily insight (30-day backfill) |
| `/api/cron/sync?job=media` | `23 10,22 * * *` (twice a day) | Full media list (backfills everything on the first run), then per-media insights |
| `/api/cron/sync?job=token` | `41 7 * * *` | Token refresh (only when `IG_AUTH_MODE=db`) |

The route requires `Authorization: Bearer $CRON_SECRET`, which Vercel sends automatically.
Sub-daily schedules need a Vercel Pro plan; the Hobby plan runs crons at most once a day.
`GET /api/sync/status` returns the last run and the last success for each job, recent runs, and
recent API errors. A run left in `running` for more than 30 minutes (for example a killed
function) is marked `failed` with the message "timed out" when the next run of its kind starts.

## Data rules (enforced in code and schema)

1. **Followers come only from the IG User `followers_count` field.** Each successful
   `GET /me?fields=followers_count,...` appends one row to `account_snapshots`. When the call
   fails, no row is written. The failure is recorded in `sync_runs` and `api_errors`. A CHECK
   allows only `source = 'instagram_graph_api'` in `account_snapshots`, and every follower query
   also filters on that source and reports the row's own source.
2. **Per-post follows come only from the `follows` media insight.** Meta's docs list `follows`
   (and `profile_visits` and `profile_activity`) for FEED and STORY only. For REELS these are
   stored as `unsupported` without calling the API. They are never computed from account growth,
   views, reach or profile visits. When the API does not return `media_product_type`, an item
   whose permalink is a `/reel/` URL is treated as a Reel (this only ever removes metrics); for
   any other item of unknown type these three metrics are not requested and are stored as
   `unavailable` with the reason "product type unknown".
3. **A missing value is `NULL` with a status, never 0.** Statuses are `available`,
   `unavailable` (the API returned nothing), `unsupported`, `error` and `pending`. A real 0 from
   the API is stored as 0 with status `available`. CHECK constraints enforce
   `status = 'available' <=> value IS NOT NULL`.
4. **Observations are append-only.** Every row carries `source`, `retrieved_at`, a status and
   `sync_run_id`. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on `account_snapshots`,
   `account_insight_observations`, `media_metric_observations`, `audit_log` and
   `tracked_account`. A CHECK rejects a `retrieved_at` more than 5 minutes after the row's
   `created_at` (which defaults to `now()` and which the production app role cannot write). A
   gap between snapshots stays a gap.

   **Values are validated.** Count metrics (`followers_count`, `follower_count`, `follows`,
   `views`, `like_count`, ...) must be non-negative safe integers. Only the duration and percentage
   metrics (`ig_reels_avg_watch_time`, `ig_reels_video_view_total_time`, `reels_skip_rate`) may be
   fractional, and they must still be finite, non-negative and bounded (percent at most 100).
   Anything else is stored as status `error` with `NULL` and the reason. CHECK constraints
   (value between 0 and 1e15, whole numbers for counts) make a bad row impossible to store.

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

- `currentFollowers` (also returns `snapshotAgeHours` and `stale` (older than 8 hours) when
  available; `snapshotAge(retrievedAt, now)` computes the same for any timestamp)
- `netGrowth('day' | 'week' | 'month')`
- `netGrowthForLocalDay('YYYY-MM-DD')`: net change over one completed local day (for example
  `previousLocalDate(now, tz)`, i.e. yesterday). It is the latest snapshot at or before the day's
  end minus the latest snapshot at or before the day's start, each within 6 hours of its
  boundary. Both snapshots are returned. The result is `unavailable` if the day has not ended or
  either snapshot is missing. DST days are 23 or 25 hours long, and the result reports
  `dayLengthHours`.
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
- `getPinnedAccount` / `getPinnedAccountId` (the tracked account)

Every function defaults to the pinned tracked account.

In `mediaWithLatestMetrics`, each metric resolves in this order:

1. `unsupported`, when Meta's docs say the product type does not have the metric, whatever is
   stored.
2. The **latest** observation, whatever its status. A newer `unavailable` or `error` is shown
   as such and never hidden behind an older number. When the latest observation is not
   available, the metric's `lastAvailable` field (`{ value, source, retrievedAt, syncRunId }`)
   carries the newest available reading so that the UI can label it "last recorded on <date>".
3. `pending`.

A stored value that cannot be read back turns that one metric into `error`; the rest of the
query is unaffected.

## Production database roles

Use two roles:

- A **migration-owner** role runs `npm run migrate` and owns every table.
- An **app** role is the one in the deployed `DATABASE_URL`. It owns nothing.

After every migration, the owner runs:

```bash
psql "$MIGRATION_OWNER_DATABASE_URL" -v app_role=social_dashboard_app -f scripts/grant-app-role.sql
```

On the observation tables, `audit_log` and `tracked_account`, the app role gets only `SELECT`
and a column-restricted `INSERT` (it cannot write `id` or `created_at`). It gets no `UPDATE`,
`DELETE`, `TRUNCATE` or ownership, so it can neither disable the append-only triggers nor
backdate `created_at`. It gets only what the sync engine needs on `ig_accounts`, `media`,
`sync_runs`, `api_errors` and `oauth_tokens`. The local setup above uses one role for both
jobs, which is fine for development only.

## Layout

```
migrations/0001_core_schema.sql   schema, constraints, append-only triggers
migrations/0002_integrity_hardening.sql  tracked_account pin, source/value/time CHECKs, TRUNCATE triggers
scripts/                          migrate.ts, sync.ts (CLI), grant-app-role.sql (production grants)
src/proxy.ts                      access gate (login session cookie)
src/lib/account/tracked.ts        tracked-account pinning and verification
src/lib/auth/                     session cookie signing, login rate limiting
src/lib/config.ts                 env config (goal, timezone, Instagram)
src/lib/provenance.ts             Provenanced<T>, formatMetric
src/lib/db/                       pool, transaction helper, migration runner
src/lib/instagram/                client, errors, metric registry, OAuth, auth resolution
src/lib/sync/                     runs (sync_runs + locking), account, media, token, orchestrator
src/lib/queries/                  query layer for the UI
src/lib/tokens/                   AES-256-GCM + encrypted token store
src/app/api/                      auth/{login,logout}, auth/instagram/{start,callback}, cron/sync, sync/status
src/app/login/                    login page
tests/{unit,db,integration}       Vitest; db + integration tests use the real local Postgres
```

`tests/integration/instagram-live.test.ts` calls the real `graph.instagram.com` with an invalid
token. It checks that error code 190 becomes a failed `sync_runs` row and an `api_errors` row,
and that no snapshot is written. Set `SKIP_LIVE_IG_TEST=1` to skip it, for example when a proxy
injects a real token or the host cannot be reached.
