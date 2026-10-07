-- 000_create_timescaledb.sql
--
-- TimescaleDB must be created in THIS database before any hypertable is defined.
-- The container image preloads the library via shared_preload_libraries but does
-- NOT create the extension per-database, so without this file the initdb run
-- aborts in 002_hypertables_compression_retention.sql with:
--   ERROR: function create_hypertable(regclass, name, chunk_time_interval => bigint,
--          if_not_exists => boolean, migrate_data => boolean) does not exist
-- The 000_ prefix makes the postgres entrypoint apply this before 001_schema.sql.
--
-- Idempotent, matching the house style of 001-007.

CREATE EXTENSION IF NOT EXISTS timescaledb;
