-- 0002: integrity hardening after the follower-tracking review.
--
--   * tracked_account: the single Instagram account this dashboard tracks, pinned by its stable
--     IG user id on the first successful account sync / OAuth connect (or pre-pinned from
--     IG_EXPECTED_USER_ID). Immutable once written.
--   * account_snapshots.source may only be the Instagram API (followers come only from the API's
--     followers_count field).
--   * Observation values must be finite, non-negative and bounded; count metrics must be whole
--     numbers. A bad value can therefore never be stored and never break a read.
--   * retrieved_at may not lie in the future (relative to the row's insertion time, created_at,
--     which defaults to now(); the production app role cannot write created_at, see
--     scripts/grant-app-role.sql).
--   * TRUNCATE is rejected on every append-only table (row triggers do not fire on TRUNCATE).
--
-- No metric data is inserted here.

-- ---------------------------------------------------------------------------
-- Tracked account (single row, immutable)
-- ---------------------------------------------------------------------------
CREATE TABLE tracked_account (
  singleton        boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  -- Stable Instagram professional account id (`user_id` from GET /me). Not a foreign key, so
  -- that it can be pre-pinned from IG_EXPECTED_USER_ID before the first sync.
  ig_user_id       text NOT NULL CHECK (length(ig_user_id) BETWEEN 1 AND 64),
  username_at_pin  text,
  pinned_via       text NOT NULL CHECK (pinned_via IN ('account_sync', 'oauth_connect', 'env')),
  pinned_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Source integrity
-- ---------------------------------------------------------------------------
ALTER TABLE account_snapshots
  ADD CONSTRAINT account_snapshots_source_api_only CHECK (source = 'instagram_graph_api');

-- ---------------------------------------------------------------------------
-- Value ranges (9007199254740991 = 2^53 - 1, the largest integer a JS number holds exactly;
-- 1e15 is far above any real Instagram figure and below that limit)
-- ---------------------------------------------------------------------------
ALTER TABLE account_snapshots
  ADD CONSTRAINT account_snapshots_followers_count_max CHECK (followers_count <= 9007199254740991),
  ADD CONSTRAINT account_snapshots_follows_count_max CHECK (follows_count <= 9007199254740991),
  ADD CONSTRAINT account_snapshots_media_count_max CHECK (media_count <= 9007199254740991),
  ADD CONSTRAINT account_snapshots_retrieved_at_not_future
    CHECK (retrieved_at <= created_at + interval '5 minutes');

ALTER TABLE account_insight_observations
  ADD CONSTRAINT account_insight_observations_value_range
    CHECK (value IS NULL OR (value >= 0 AND value <= 1e15)),
  -- every account insight stored so far (follower_count) is a count
  ADD CONSTRAINT account_insight_observations_value_integer
    CHECK (value IS NULL OR value = trunc(value)),
  ADD CONSTRAINT account_insight_observations_retrieved_at_not_future
    CHECK (retrieved_at <= created_at + interval '5 minutes');

ALTER TABLE media_metric_observations
  ADD CONSTRAINT media_metric_observations_value_range
    CHECK (value IS NULL OR (value >= 0 AND value <= 1e15)),
  -- Only duration / percentage metrics may be fractional; every other metric is a count.
  ADD CONSTRAINT media_metric_observations_value_integer
    CHECK (value IS NULL
           OR metric IN ('ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate')
           OR value = trunc(value)),
  ADD CONSTRAINT media_metric_observations_percent_max
    CHECK (value IS NULL OR metric <> 'reels_skip_rate' OR value <= 100),
  ADD CONSTRAINT media_metric_observations_retrieved_at_not_future
    CHECK (retrieved_at <= created_at + interval '5 minutes');

-- ---------------------------------------------------------------------------
-- Append-only: TRUNCATE (statement level) and the immutable pin
-- ---------------------------------------------------------------------------
CREATE TRIGGER account_snapshots_no_truncate
  BEFORE TRUNCATE ON account_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER account_insight_observations_no_truncate
  BEFORE TRUNCATE ON account_insight_observations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER media_metric_observations_no_truncate
  BEFORE TRUNCATE ON media_metric_observations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER tracked_account_append_only
  BEFORE UPDATE OR DELETE ON tracked_account
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER tracked_account_no_truncate
  BEFORE TRUNCATE ON tracked_account
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
