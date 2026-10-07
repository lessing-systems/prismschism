-- ============================================================================
-- 002_hypertables_compression_retention.sql
-- Phase: DB Batch B3
-- Date: 2026-09-29
--
-- Purpose:
--   1. Convert 6 existing tables to hypertables (1-day chunks on ts)
--   2. Enable columnstore compression (segmentby + orderby)
--   3. Add compression policy (compress_after = 2 days)
--   4. Add retention policy (drop_after = 7 days)
--
-- Idempotency:
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
-- 1. HYPERTABLES (1-day chunks, partition on ts)
-- ---------------------------------------------------------------------------

-- 1 day = 86400 seconds = 86400000000 microseconds
SELECT create_hypertable('tokens'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

SELECT create_hypertable('latency'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

SELECT create_hypertable('requests'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

SELECT create_hypertable('spend'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

SELECT create_hypertable('limits'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

SELECT create_hypertable('instance_health'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

-- ---------------------------------------------------------------------------
-- 2. COMPRESSION (columnstore)
--    segmentby: api_provider (5 metric tables) | backend (instance_health)
--    orderby:   ts DESC  (time-descending enables RLE on idle runs)
--
--    NOTE: instance_health uses 'backend' instead of 'api_provider' because
--    the table has no api_provider column; 'backend' is the
--    analogous low-cardinality segment key for the health family.
-- ---------------------------------------------------------------------------

-- tokens
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'tokens'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE tokens SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- latency
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'latency'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE latency SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- requests
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'requests'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE requests SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- spend
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'spend'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE spend SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- limits
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'limits'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE limits SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- instance_health
-- DEVIATION: segmentby = 'backend' (not 'api_provider') — instance_health has
-- no api_provider column; 'backend' is the equivalent low-cardinality key.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'instance_health'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE instance_health SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'backend',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. COMPRESSION POLICY (compress_after = 2 days)
--    NOTE: must stay > cagg refresh_start in 003
-- ---------------------------------------------------------------------------

SELECT add_compression_policy('tokens',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_compression_policy('latency',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_compression_policy('requests',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_compression_policy('spend',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_compression_policy('limits',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_compression_policy('instance_health',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- 4. RETENTION POLICY
-- ---------------------------------------------------------------------------

SELECT add_retention_policy('tokens',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('latency',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('requests',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('spend',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('limits',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('instance_health',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);
