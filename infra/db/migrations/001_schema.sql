-- ============================================================================
-- 001_schema.sql — Core schema (Phase: DB Batch B2)
-- Date: 2026-09-29
-- Notes: value NULL = scraped-idle — never NOT NULL.
--        api_base is stripped from all 5 metric families.
--        Identity columns are raw-tier only.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).
-- ============================================================================

BEGIN;

-- Family: tokens (unit: tokens) — api_base stripped
CREATE TABLE IF NOT EXISTS tokens (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

-- Family: latency (unit: s|ms) — api_base stripped
CREATE TABLE IF NOT EXISTS latency (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

-- Family: requests (unit: count) — api_base stripped
CREATE TABLE IF NOT EXISTS requests (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

-- Family: spend (unit: usd) — api_base stripped
CREATE TABLE IF NOT EXISTS spend (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

-- Family: limits (unit: ratio) — api_base stripped
CREATE TABLE IF NOT EXISTS limits (
    ts               timestamptz NOT NULL,
    model            text,
    model_id         text,
    api_provider     text,
    value            double precision,
    unit             text,
    hashed_api_key   text,
    api_key_alias    text,
    "user"           text,
    team             text
);

-- Health family — no api_base per contract
CREATE TABLE IF NOT EXISTS instance_health (
    ts                   timestamptz NOT NULL,
    backend              text,
    model_id             text,
    up                   boolean,
    status               text,
    scraper_health_value double precision
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tokens_api_provider_ts       ON tokens (api_provider, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_model_id_ts          ON tokens (model_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_latency_api_provider_ts     ON latency (api_provider, ts DESC);
CREATE INDEX IF NOT EXISTS idx_latency_model_id_ts         ON latency (model_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_api_provider_ts    ON requests (api_provider, ts DESC);
CREATE INDEX IF NOT EXISTS idx_requests_model_id_ts        ON requests (model_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_spend_api_provider_ts       ON spend (api_provider, ts DESC);
CREATE INDEX IF NOT EXISTS idx_spend_model_id_ts           ON spend (model_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_limits_api_provider_ts      ON limits (api_provider, ts DESC);
CREATE INDEX IF NOT EXISTS idx_limits_model_id_ts          ON limits (model_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_instance_health_backend_ts  ON instance_health (backend, ts DESC);
CREATE INDEX IF NOT EXISTS idx_instance_health_model_id_ts ON instance_health (model_id, ts DESC);

COMMIT;
