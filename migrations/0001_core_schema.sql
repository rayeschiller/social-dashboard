-- Phase 1 core schema: accounts, tokens, sync runs, append-only metric observations.
--
-- Rules this schema enforces (see README "Data rules"):
--   * Every metric observation carries source, retrieved_at, availability status and sync_run_id.
--   * A missing value is NULL with a non-'available' status; a real 0 is 0 with status 'available'.
--     CHECK constraints make "available <=> value IS NOT NULL" impossible to violate.
--   * Observation tables are append-only: UPDATE and DELETE are rejected by triggers.
--   * No metric data is inserted by migrations. The only rows inserted here are reference rows
--     describing data sources.

-- ---------------------------------------------------------------------------
-- Reference: data sources (open set: later phases add rows, never alter columns)
-- ---------------------------------------------------------------------------
CREATE TABLE metric_sources (
  source        text PRIMARY KEY CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  description   text NOT NULL,
  is_automated  boolean NOT NULL,
  -- true when values from this source must name the person who entered them
  requires_entered_by boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO metric_sources (source, description, is_automated, requires_entered_by) VALUES
  ('instagram_graph_api',
   'Instagram API with Instagram Login (graph.instagram.com), read by the sync engine',
   true, false),
  ('instagram_app_insights_manual',
   'Figure read by a person from Instagram in-app Insights and entered by hand (reserved for a later phase)',
   false, true);

-- ---------------------------------------------------------------------------
-- Accounts and credentials
-- ---------------------------------------------------------------------------
CREATE TABLE ig_accounts (
  -- Instagram professional account ID (`user_id` from GET /me with Instagram Login).
  ig_user_id      text PRIMARY KEY,
  app_scoped_id   text,
  username        text NOT NULL,
  account_type    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Long-lived Instagram User access tokens, AES-256-GCM encrypted. Rows are never deleted;
-- a refreshed token is a new row and the previous one gets superseded_at.
CREATE TABLE oauth_tokens (
  id                bigserial PRIMARY KEY,
  ig_user_id        text NOT NULL REFERENCES ig_accounts(ig_user_id),
  key_version       smallint NOT NULL DEFAULT 1,
  token_iv          bytea NOT NULL,
  token_ciphertext  bytea NOT NULL,
  token_auth_tag    bytea NOT NULL,
  token_type        text NOT NULL DEFAULT 'bearer',
  scopes            text[] NOT NULL DEFAULT '{}',
  obtained_via      text NOT NULL CHECK (obtained_via IN ('oauth_callback', 'refresh')),
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz,
  superseded_at     timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_active_idx ON oauth_tokens (ig_user_id, issued_at DESC)
  WHERE superseded_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Sync runs
-- ---------------------------------------------------------------------------
CREATE TABLE sync_runs (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN (
                    'account', 'account_insights', 'media', 'media_insights',
                    'token_refresh', 'manual_entry')),
  trigger         text NOT NULL CHECK (trigger IN ('cron', 'cli', 'oauth', 'manual', 'test')),
  ig_user_id      text REFERENCES ig_accounts(ig_user_id),
  auth_mode       text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  error_code      text,
  error_message   text,
  error_detail    jsonb,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX sync_runs_kind_started_idx ON sync_runs (kind, started_at DESC);
CREATE INDEX sync_runs_status_idx ON sync_runs (status, started_at DESC);

-- Raw API failures (one row per failed HTTP exchange after retries, or per isolated metric failure).
CREATE TABLE api_errors (
  id              bigserial PRIMARY KEY,
  sync_run_id     bigint REFERENCES sync_runs(id),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  endpoint        text NOT NULL,          -- path + non-secret query, never a token
  http_status     integer,
  error_code      integer,
  error_subcode   integer,
  error_type      text,
  classification  text NOT NULL CHECK (classification IN (
                    'auth', 'permission', 'unsupported_metric', 'insufficient_data',
                    'not_found', 'rate_limit', 'transient', 'network', 'invalid_request',
                    'invalid_response', 'unknown')),
  message         text NOT NULL,
  fbtrace_id      text,
  ig_media_id     text,
  metric          text,
  attempts        integer NOT NULL DEFAULT 1
);
CREATE INDEX api_errors_occurred_idx ON api_errors (occurred_at DESC);
CREATE INDEX api_errors_run_idx ON api_errors (sync_run_id);

-- ---------------------------------------------------------------------------
-- Shared status domain
-- ---------------------------------------------------------------------------
-- available   : value came from the source (0 is a real value)
-- unavailable : the source returned no value for it (e.g. empty insights data set, field omitted)
-- unsupported : the source does not provide this metric for this object (e.g. follows on REELS)
-- error       : the request failed (details in error_* columns / api_errors)
-- pending     : not fetched yet (used by the query layer; may be stored by later phases)

-- ---------------------------------------------------------------------------
-- Account follower snapshots (followers_count field of the IG User). Append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE account_snapshots (
  id                     bigserial PRIMARY KEY,
  ig_user_id             text NOT NULL REFERENCES ig_accounts(ig_user_id),
  followers_count        bigint CHECK (followers_count >= 0),
  followers_count_status text NOT NULL
    CHECK (followers_count_status IN ('available', 'unavailable', 'unsupported', 'error', 'pending')),
  follows_count          bigint CHECK (follows_count >= 0),
  follows_count_status   text NOT NULL
    CHECK (follows_count_status IN ('available', 'unavailable', 'unsupported', 'error', 'pending')),
  media_count            bigint CHECK (media_count >= 0),
  media_count_status     text NOT NULL
    CHECK (media_count_status IN ('available', 'unavailable', 'unsupported', 'error', 'pending')),
  source                 text NOT NULL REFERENCES metric_sources(source),
  retrieved_at           timestamptz NOT NULL,
  sync_run_id            bigint NOT NULL REFERENCES sync_runs(id),
  status_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((followers_count_status = 'available') = (followers_count IS NOT NULL)),
  CHECK ((follows_count_status = 'available') = (follows_count IS NOT NULL)),
  CHECK ((media_count_status = 'available') = (media_count IS NOT NULL)),
  -- one snapshot per account per run, so a retried run cannot double-write
  UNIQUE (ig_user_id, sync_run_id)
);
CREATE INDEX account_snapshots_followers_idx
  ON account_snapshots (ig_user_id, retrieved_at DESC)
  WHERE followers_count_status = 'available';

-- ---------------------------------------------------------------------------
-- Account-level insights (e.g. follower_count period=day = NEW followers per day; NOT a net count).
-- Append-only. A (metric, period, end_time) row is only appended when its value/status differs
-- from the latest stored observation for that key, so re-syncing the same days writes nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE account_insight_observations (
  id                     bigserial PRIMARY KEY,
  ig_user_id             text NOT NULL REFERENCES ig_accounts(ig_user_id),
  metric                 text NOT NULL,
  period                 text NOT NULL,
  end_time               timestamptz NOT NULL,   -- end_time reported by the API for the period
  value                  numeric,
  status                 text NOT NULL
    CHECK (status IN ('available', 'unavailable', 'unsupported', 'error', 'pending')),
  is_platform_estimated  boolean NOT NULL DEFAULT false,
  source                 text NOT NULL REFERENCES metric_sources(source),
  retrieved_at           timestamptz NOT NULL,
  sync_run_id            bigint NOT NULL REFERENCES sync_runs(id),
  status_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'available') = (value IS NOT NULL)),
  UNIQUE (ig_user_id, metric, period, end_time, sync_run_id)
);
CREATE INDEX account_insight_obs_key_idx
  ON account_insight_observations (ig_user_id, metric, period, end_time, retrieved_at DESC);

-- ---------------------------------------------------------------------------
-- Media (descriptive metadata only; counts/metrics live in media_metric_observations)
-- ---------------------------------------------------------------------------
CREATE TABLE media (
  ig_media_id             text PRIMARY KEY,
  ig_user_id              text NOT NULL REFERENCES ig_accounts(ig_user_id),
  shortcode               text,
  shortcode_source        text CHECK (shortcode_source IN ('api', 'permalink')),
  permalink               text,
  caption                 text,
  media_type              text,           -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type      text,           -- FEED | REELS | STORY | AD (NULL if the API omitted it)
  published_at            timestamptz,
  thumbnail_url           text,
  media_url               text,           -- optional; often omitted by the API
  first_seen_at           timestamptz NOT NULL,
  last_seen_at            timestamptz NOT NULL,
  first_seen_sync_run_id  bigint NOT NULL REFERENCES sync_runs(id),
  last_seen_sync_run_id   bigint NOT NULL REFERENCES sync_runs(id),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((shortcode IS NULL) = (shortcode_source IS NULL))
);
CREATE INDEX media_account_published_idx ON media (ig_user_id, published_at DESC);
CREATE INDEX media_shortcode_idx ON media (shortcode);

-- ---------------------------------------------------------------------------
-- Per-media metric observations. Append-only history: one row per (media, metric, sync run).
-- ---------------------------------------------------------------------------
CREATE TABLE media_metric_observations (
  id                     bigserial PRIMARY KEY,
  ig_media_id            text NOT NULL REFERENCES media(ig_media_id),
  metric                 text NOT NULL,
  -- 'insight' = GET /<media>/insights, 'field' = a field on the IG Media node (like_count, ...),
  -- 'manual' = reserved for hand-entered figures
  metric_origin          text NOT NULL CHECK (metric_origin IN ('insight', 'field', 'manual')),
  value                  numeric,
  status                 text NOT NULL
    CHECK (status IN ('available', 'unavailable', 'unsupported', 'error', 'pending')),
  -- Meta's own "Metric is estimated" label from its docs; not a judgement made by this app
  is_platform_estimated  boolean NOT NULL DEFAULT false,
  source                 text NOT NULL REFERENCES metric_sources(source),
  retrieved_at           timestamptz NOT NULL,
  sync_run_id            bigint NOT NULL REFERENCES sync_runs(id),
  status_reason          text,
  error_code             integer,
  error_message          text,
  api_error_id           bigint REFERENCES api_errors(id),
  -- reserved for source = 'instagram_app_insights_manual'
  entered_by             text,
  entered_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'available') = (value IS NOT NULL)),
  CHECK ((entered_by IS NULL) = (entered_at IS NULL)),
  UNIQUE (ig_media_id, metric, sync_run_id)
);
CREATE INDEX media_metric_obs_latest_idx
  ON media_metric_observations (ig_media_id, metric, retrieved_at DESC, id DESC);

-- Hand-entered observations must say who entered them.
CREATE FUNCTION enforce_manual_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT requires_entered_by FROM metric_sources WHERE source = NEW.source)
     AND NEW.entered_by IS NULL THEN
    RAISE EXCEPTION 'source % requires entered_by/entered_at', NEW.source;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_metric_observations_manual_entry
  BEFORE INSERT ON media_metric_observations
  FOR EACH ROW EXECUTE FUNCTION enforce_manual_entry();

-- ---------------------------------------------------------------------------
-- Audit log (security-relevant and operator actions; never contains secrets)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END $$;

CREATE TRIGGER account_snapshots_append_only
  BEFORE UPDATE OR DELETE ON account_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER account_insight_observations_append_only
  BEFORE UPDATE OR DELETE ON account_insight_observations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER media_metric_observations_append_only
  BEFORE UPDATE OR DELETE ON media_metric_observations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
