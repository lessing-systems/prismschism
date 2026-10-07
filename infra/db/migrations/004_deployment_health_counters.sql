-- ============================================================================
-- 004_deployment_health_counters.sql
-- Phase: DB Batch B4
-- Date: 2026-09-30
--
-- Purpose:
--   1. Create deployment_health: the litellm_deployment_state gauge stored as
--      real health state, composite-keyed by (model_id, litellm_model_name).
--      This is NOT traffic-light state and NOT instance scrape health
--      (instance_health stays reserved for per-backend scrape health).
--   2. Create counters: the generic event-counter family for
--      litellm_deployment_cooled_down_total, labelled by
--      (model_id, exception_status).
--   3. Convert both to hypertables (1-day chunks on ts)
--   4. Enable columnstore compression (segmentby model_id, orderby ts DESC)
--   5. Add compression policy (compress_after = 2 days)
--   6. Add retention policy (drop_after = 7 days)
--
-- Idempotency:
--   - CREATE TABLE IF NOT EXISTS
--   - create_hypertable(... if_not_exists => TRUE, migrate_data => TRUE)
--   - Compression: guarded by segmentby IS NOT NULL check on
--     timescaledb_information.hypertable_compression_settings
--   - add_compression_policy / add_retention_policy: if_not_exists => TRUE
--   The entire script is safe to re-run with zero errors.
--
-- NOTE: No explicit BEGIN/COMMIT — each statement auto-commits.
--   This is required because add_compression_policy cannot see uncommitted
--   catalog changes from ALTER TABLE SET within the same transaction.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------------

-- deployment_health: one row per scrape per (model_id, litellm_model_name).
-- status is the normalised gauge value ('healthy' | 'error'); the raw 0/1/2
-- gauge value is intentionally not stored.
CREATE TABLE IF NOT EXISTS deployment_health (
    ts                 timestamptz NOT NULL,
    model_id           text,
    litellm_model_name text,
    status             text
);

-- counters: generic low-cardinality event counters. value carries the
-- per-interval delta; unit is the counter unit.
CREATE TABLE IF NOT EXISTS counters (
    ts               timestamptz NOT NULL,
    model_id         text,
    exception_status text,
    value            double precision,
    unit             text
);

-- ---------------------------------------------------------------------------
-- 2. HYPERTABLES (1-day chunks, partition on ts)
-- ---------------------------------------------------------------------------

-- 1 day = 86400 seconds = 86400000000 microseconds
SELECT create_hypertable('deployment_health'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

SELECT create_hypertable('counters'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

-- ---------------------------------------------------------------------------
-- 3. COMPRESSION (columnstore)
--    segmentby: model_id (both tables — the low-cardinality deployment axis)
--    orderby:   ts DESC  (time-descending enables RLE on idle runs)
-- ---------------------------------------------------------------------------

-- deployment_health
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'deployment_health'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE deployment_health SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'model_id',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- counters
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'counters'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE counters SET (
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

SELECT add_compression_policy('deployment_health',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_compression_policy('counters',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- 5. RETENTION POLICY
-- ---------------------------------------------------------------------------

SELECT add_retention_policy('deployment_health',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('counters',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);
