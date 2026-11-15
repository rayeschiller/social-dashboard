-- Least-privilege grants for the production APP role (the role in the app's DATABASE_URL).
--
-- Run as the MIGRATION-OWNER role (the role that ran `npm run migrate` and owns the tables),
-- after every migration:
--
--   psql "$MIGRATION_OWNER_DATABASE_URL" -v app_role=social_dashboard_app -f scripts/grant-app-role.sql
--
-- The app role must be a separate LOGIN role that owns nothing, e.g. (as a superuser):
--   CREATE ROLE social_dashboard_app LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--
-- What this gives the app role:
--   * observation tables (account_snapshots, account_insight_observations,
--     media_metric_observations), audit_log and tracked_account: SELECT + INSERT only, and INSERT
--     only on the listed columns. `id` and `created_at` are not grantable, so created_at is always
--     the database's now() and the "retrieved_at not in the future" CHECK holds against the real
--     clock. No UPDATE, DELETE or TRUNCATE (the triggers reject those for the owner too).
--   * operational tables the sync engine maintains (ig_accounts, media, sync_runs, oauth_tokens,
--     api_errors): the minimum it writes.
--   * no ownership, so it cannot ALTER TABLE / DISABLE TRIGGER / DROP anything.
\set ON_ERROR_STOP on

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"app_role";
REVOKE CREATE ON SCHEMA public FROM :"app_role";
GRANT USAGE ON SCHEMA public TO :"app_role";

-- Reference / bookkeeping: read only
GRANT SELECT ON metric_sources, schema_migrations TO :"app_role";

-- Append-only observation tables: SELECT + column-restricted INSERT
GRANT SELECT ON account_snapshots TO :"app_role";
GRANT INSERT (ig_user_id, followers_count, followers_count_status, follows_count, follows_count_status,
              media_count, media_count_status, source, retrieved_at, sync_run_id, status_reason)
  ON account_snapshots TO :"app_role";

GRANT SELECT ON account_insight_observations TO :"app_role";
GRANT INSERT (ig_user_id, metric, period, end_time, value, status, is_platform_estimated, source,
              retrieved_at, sync_run_id, status_reason)
  ON account_insight_observations TO :"app_role";

GRANT SELECT ON media_metric_observations TO :"app_role";
GRANT INSERT (ig_media_id, metric, metric_origin, value, status, is_platform_estimated, source,
              retrieved_at, sync_run_id, status_reason, error_code, error_message, api_error_id,
              entered_by, entered_at)
  ON media_metric_observations TO :"app_role";

GRANT SELECT ON audit_log TO :"app_role";
GRANT INSERT (actor, action, entity_type, entity_id, detail) ON audit_log TO :"app_role";

GRANT SELECT ON tracked_account TO :"app_role";
GRANT INSERT (ig_user_id, username_at_pin, pinned_via) ON tracked_account TO :"app_role";

-- Operational tables
GRANT SELECT, INSERT, UPDATE ON ig_accounts TO :"app_role";
GRANT SELECT, INSERT, UPDATE ON media TO :"app_role";
GRANT SELECT, INSERT, UPDATE ON sync_runs TO :"app_role";
GRANT SELECT, INSERT ON api_errors TO :"app_role";
GRANT SELECT, INSERT ON oauth_tokens TO :"app_role";
GRANT UPDATE (superseded_at) ON oauth_tokens TO :"app_role";

-- bigserial ids
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
