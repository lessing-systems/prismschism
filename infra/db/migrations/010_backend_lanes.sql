-- ============================================================================
-- 010_backend_lanes.sql
-- Date: 2026-10-11
-- Idempotent: safe to re-apply on databases where it was applied manually.
--
-- Purpose:
--   Create backend_lanes: per-backend tensorfold lane gauges. Four source
--   metrics, ALL GAUGES (IsCounter=false rows — raw readings, no deltas):
--     tensorfold:requests_running    → metric 'running'
--     tensorfold:requests_waiting    → metric 'waiting'
--     tensorfold_health:streams_max  → metric 'max'
--     tensorfold_health:streams      → metric 'streams_' + state label
--                                       (decoding / filling / paused)
--   The metric names contain ':' — valid per the Prometheus text-format name
--   grammar and natively accepted by the scraper's expfmt parser. The short
--   lane name is derived in parser buildRow and carried on Row.MetricName;
--   Row.Backend carries the backend identity (empty string when the source
--   series is unlabeled, per the column's NOT NULL DEFAULT '').
--
-- Modeled on 004_deployment_health_counters.sql / 009_in_flight.sql:
--   1. Create backend_lanes (ts, backend, metric, value, unit)
--   2. Convert to hypertable (1-day chunks on ts)
--   3. Enable columnstore compression (segmentby backend, orderby ts DESC)
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
-- NOTE: No explicit BEGIN/COMMIT — each statement auto-commits.
--   This is required because add_compression_policy cannot see uncommitted
--   catalog changes from ALTER TABLE SET within the same transaction.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. TABLE
-- ---------------------------------------------------------------------------

-- backend_lanes: one row per scrape per (backend, lane metric). value is the
-- raw gauge reading (lane occupancy); unit is the unit label or the family
-- default ("lanes"). backend is the empty string when the source series
-- carries no backend label (the live tensorfold gauges are unlabeled).
CREATE TABLE IF NOT EXISTS backend_lanes (
    ts     timestamptz NOT NULL,
    backend text NOT NULL DEFAULT '',
    metric text NOT NULL,
    value  double precision NOT NULL,
    unit   text NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2. HYPERTABLE (1-day chunks, partition on ts)
-- ---------------------------------------------------------------------------

-- 1 day = 86400 seconds = 86400000000 microseconds
SELECT create_hypertable('backend_lanes'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

-- ---------------------------------------------------------------------------
-- 3. COMPRESSION (columnstore)
--    segmentby: backend (the low-cardinality identity axis)
--    orderby:   ts DESC  (time-descending enables RLE on idle runs)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'backend_lanes'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE backend_lanes SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'backend',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. COMPRESSION POLICY (compress_after = 2 days)
-- ---------------------------------------------------------------------------

SELECT add_compression_policy('backend_lanes',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- 5. RETENTION POLICY
-- ---------------------------------------------------------------------------

SELECT add_retention_policy('backend_lanes',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);
