-- ============================================================================
-- 005_token_families.sql — Per-family token hypertables (replaces merged tokens)
-- Phase: DB Batch B5
-- Date: 2026-09-30
--
-- Purpose:
--   The merged `tokens` family (001) collapsed every Prometheus token metric into
--   one hypertable, so input/output/cached/reasoning totals were indistinguishable.
--   Each metric family gets its OWN hypertable plus an explicit `unit`
--   column, so the token metrics are split into five families, all unit='tokens':
--     input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens
--   Each also carries a `metric text` column holding the ORIGINAL Prometheus metric
--   name (LOCKED CONTRACT — must match the parallel Go scraper change exactly).
--
-- Columns (identical for all five): ts, model, model_id, api_provider, value, unit,
--   metric, hashed_api_key, api_key_alias, "user", team.
--   value NULL = scraped-idle — never NOT NULL.
--
-- Style: mirrors 001 (CREATE TABLE IF NOT EXISTS) and 002 exactly —
--   create_hypertable(... if_not_exists => TRUE, migrate_data => TRUE), compression
--   enabled via a DO block guarded on
--   timescaledb_information.hypertable_compression_settings (segmentby IS NOT NULL),
--   then add_compression_policy / add_retention_policy with if_not_exists => TRUE.
--   Raw-tier policy values are identical to the ones 002 applies to the old merged
--   `tokens` table: 1-day chunks, segmentby=api_provider, orderby=ts DESC,
--   compress_after=2 days, retention=7 days.
--
-- NOTE: No explicit BEGIN/COMMIT — each statement auto-commits (same reason as 002:
--   add_compression_policy cannot see uncommitted catalog changes from an ALTER TABLE
--   SET in the same transaction).
--
-- NOTE: The legacy merged `tokens` hypertable and its tokens_1m/5m/1h continuous
--   aggregates are NOT touched here. Removing them is a deliberate DATA WIPE and
--   lives in infra/db/wipe_merged_tokens.sql (dev-only, run manually).
--
-- OPTIONAL FOLLOW-UP (deliberately out of scope): per-family continuous aggregates
--   for these five tables (e.g. input_tokens_1m ... total_tokens_1h) following 003's
--   per-family cagg pattern, plus their refresh/compression/retention policies.
--   No caggs are created in this migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Family: input_tokens (unit: tokens)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS input_tokens (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    metric           text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

SELECT create_hypertable('input_tokens'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'input_tokens'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE input_tokens SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

SELECT add_compression_policy('input_tokens',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('input_tokens',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- Family: output_tokens (unit: tokens)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS output_tokens (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    metric           text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

SELECT create_hypertable('output_tokens'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'output_tokens'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE output_tokens SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

SELECT add_compression_policy('output_tokens',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('output_tokens',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- Family: cached_tokens (unit: tokens)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cached_tokens (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    metric           text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

SELECT create_hypertable('cached_tokens'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'cached_tokens'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE cached_tokens SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

SELECT add_compression_policy('cached_tokens',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('cached_tokens',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- Family: reasoning_tokens (unit: tokens)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reasoning_tokens (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    metric           text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

SELECT create_hypertable('reasoning_tokens'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'reasoning_tokens'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE reasoning_tokens SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

SELECT add_compression_policy('reasoning_tokens',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('reasoning_tokens',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- Family: total_tokens (unit: tokens)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS total_tokens (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    metric           text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

SELECT create_hypertable('total_tokens'::regclass, 'ts'::name,
    chunk_time_interval => 86400000000,
    if_not_exists => TRUE,
    migrate_data => TRUE
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'total_tokens'::regclass AND segmentby IS NOT NULL
    ) THEN
        ALTER TABLE total_tokens SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'api_provider',
            timescaledb.compress_orderby = 'ts DESC'
        );
    END IF;
END
$$;

SELECT add_compression_policy('total_tokens',
    compress_after => INTERVAL '2 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy('total_tokens',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);
