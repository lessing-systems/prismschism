-- ============================================================================
-- 009_in_flight.sql
-- Date: 2026-10-11
-- Idempotent: safe to re-apply on databases where it was applied manually.
--
-- Purpose:
--   Create in_flight: the litellm_in_flight_requests GAUGE — the number of
--   HTTP requests currently in flight on the LiteLLM worker. The gauge is
--   GLOBAL and UNLABELED at the source (no model_id / api_key_alias), so the
--   table carries no identity columns and no metric column: one row per
--   scrape, model_id stored as the empty string per the scraper's existing
--   missing-label convention (parser buildRow emits "" for absent labels).
--   The value is a raw gauge reading (IsCounter=false), not a delta.
--
-- Modeled on 004_deployment_health_counters.sql:
--   1. Create in_flight (ts, model_id, value, unit)
--   2. Convert to hypertable (1-day chunks on ts)
--   3. Enable columnstore compression (segmentby model_id, orderby ts DESC)
--   4. Add compression policy (compress_after = 2 days)
--   5. Add retention policy (drop_after = 7 days)
--
-- Idempotency:
--   - CREATE TABLE IF NOT EXISTS
--   - create_hypertable(... if_not_exists => TRUE, migrate_data => TRUE)
--   - Compression: guarded by segmentby IS NOT NULL check on
--     timescaledb_information.hypertable_compression_settings
--   - add_compression_policy / add_retention_policy: if_not_exists => TRUE
--   The entire script is safe to re-run with zero errors.
--
-- Transaction contract: the db-migrate runner wraps this file in a single
--   transaction (psql -1); verified on timescaledb 2.30.1 / pg16 — including
--   add_compression_policy visibility of same-transaction catalog changes.
--   If applying manually WITHOUT a transaction wrapper, note that policy
--   functions may need the statements split.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. TABLE
-- ---------------------------------------------------------------------------

-- in_flight: one row per scrape. value is the raw gauge reading (concurrent
-- in-flight requests); unit is the unit label or family default ("count").
-- model_id is the empty string (the source series is unlabeled; no identity
-- columns are added — the gauge is global to the LiteLLM process).
CREATE TABLE IF NOT EXISTS in_flight (
    ts       timestamptz NOT NULL,
    model_id text,
    value    double precision,
    unit     text
);

-- ---------------------------------------------------------------------------
-- 2. HYPERTABLE (1-day chunks, partition on ts)
-- ---------------------------------------------------------------------------

-- 1 day = 86400 seconds = 86400000000 microseconds
SELECT create_hypertable('in_flight'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

-- ---------------------------------------------------------------------------
-- 3. COMPRESSION (columnstore)
--    segmentby: model_id (the low-cardinality identity axis — empty string
--               here, kept for consistency with the other per-family tables
--               so future labeled in-flight series group correctly)
--    orderby:   ts DESC  (time-descending enables RLE on idle runs)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'in_flight'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE in_flight SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'model_id',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. COMPRESSION POLICY (compress_after = 2 days)
-- ---------------------------------------------------------------------------

SELECT add_compression_policy('in_flight',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- 5. RETENTION POLICY
-- ---------------------------------------------------------------------------

SELECT add_retention_policy('in_flight',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);
