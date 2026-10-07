-- 003_continuous_aggregates.sql — Continuous aggregate tiers
-- NAMING DEVIATION (reported): the batch contract named tiers metrics_1m/5m/1h as
-- unified views. TimescaleDB 2.30 caggs REJECT UNION ALL / sub-queries in FROM
-- ("Sub-queries are not supported in FROM clause"), so a single unified
-- per-tier view over the 5 raw family tables is impossible. Per the contract's
-- fallback, we implement PER-FAMILY caggs per tier: <family>_<tier>, e.g.
-- tokens_1m ... limits_1h (5 families x 3 tiers = 15 caggs).
--
-- GROUP BY: model + api_provider ONLY. Identity columns (hashed_api_key,
-- api_key_alias, "user", team) are NEVER carried into any cagg.
--
-- COUPLING CAVEAT: the raw compress/retention window
-- (compress_after='2 days', retention 7d) MUST exceed every cagg
-- refresh_start offset so a rollup never reads dropped or compressed raw
-- chunks. Largest refresh_start here = '12 hours' << '2 days'. If raw
-- compress_after is ever lowered below 12h, lower these offsets too.
--
-- Nullable raw `value`: SUM/AVG/MAX/COUNT skip NULLs; COUNT(value) = non-null
-- sample count.
--
-- Per-tier policy matrix:
--   1m: refresh 2h/1m/1m   | compress_after 7d  | retention 30d
--   5m: refresh 4h/5m/5m   | compress_after 14d | retention 90d
--   1h: refresh 12h/1h/1h  | compress_after 30d | retention 90d
-- Cagg compress_after is kept well above that tier's refresh_start so refresh
-- never writes into an already-compressed cagg chunk.

BEGIN;

-- ================= 1-MINUTE TIER =================
CREATE MATERIALIZED VIEW IF NOT EXISTS tokens_1m WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM tokens GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS latency_1m WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM latency GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS requests_1m WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM requests GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS spend_1m WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM spend GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS limits_1m WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM limits GROUP BY bucket, model, api_provider, unit WITH NO DATA;

-- ================= 5-MINUTE TIER =================
CREATE MATERIALIZED VIEW IF NOT EXISTS tokens_5m WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM tokens GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS latency_5m WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM latency GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS requests_5m WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM requests GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS spend_5m WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM spend GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS limits_5m WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM limits GROUP BY bucket, model, api_provider, unit WITH NO DATA;

-- ================= 1-HOUR TIER =================
CREATE MATERIALIZED VIEW IF NOT EXISTS tokens_1h WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM tokens GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS latency_1h WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM latency GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS requests_1h WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM requests GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS spend_1h WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM spend GROUP BY bucket, model, api_provider, unit WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS limits_1h WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket, model, api_provider, unit,
  SUM(value) AS sum_value, AVG(value) AS avg_value, MAX(value) AS max_value, COUNT(value) AS sample_count
FROM limits GROUP BY bucket, model, api_provider, unit WITH NO DATA;

-- ================= REFRESH POLICIES =================
-- 1m tier: refresh_start '2 hours' — MUST stay well below raw compress_after '2 days'.
SELECT add_continuous_aggregate_policy('tokens_1m',   start_offset=>INTERVAL '2 hours',  end_offset=>INTERVAL '1 minute',  schedule_interval=>INTERVAL '1 minute',  if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('latency_1m',  start_offset=>INTERVAL '2 hours',  end_offset=>INTERVAL '1 minute',  schedule_interval=>INTERVAL '1 minute',  if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('requests_1m', start_offset=>INTERVAL '2 hours',  end_offset=>INTERVAL '1 minute',  schedule_interval=>INTERVAL '1 minute',  if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('spend_1m',    start_offset=>INTERVAL '2 hours',  end_offset=>INTERVAL '1 minute',  schedule_interval=>INTERVAL '1 minute',  if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('limits_1m',   start_offset=>INTERVAL '2 hours',  end_offset=>INTERVAL '1 minute',  schedule_interval=>INTERVAL '1 minute',  if_not_exists=>TRUE);
-- 5m tier
SELECT add_continuous_aggregate_policy('tokens_5m',   start_offset=>INTERVAL '4 hours',  end_offset=>INTERVAL '5 minutes', schedule_interval=>INTERVAL '5 minutes', if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('latency_5m',  start_offset=>INTERVAL '4 hours',  end_offset=>INTERVAL '5 minutes', schedule_interval=>INTERVAL '5 minutes', if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('requests_5m', start_offset=>INTERVAL '4 hours',  end_offset=>INTERVAL '5 minutes', schedule_interval=>INTERVAL '5 minutes', if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('spend_5m',    start_offset=>INTERVAL '4 hours',  end_offset=>INTERVAL '5 minutes', schedule_interval=>INTERVAL '5 minutes', if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('limits_5m',   start_offset=>INTERVAL '4 hours',  end_offset=>INTERVAL '5 minutes', schedule_interval=>INTERVAL '5 minutes', if_not_exists=>TRUE);
-- 1h tier
SELECT add_continuous_aggregate_policy('tokens_1h',   start_offset=>INTERVAL '12 hours', end_offset=>INTERVAL '1 hour',    schedule_interval=>INTERVAL '1 hour',    if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('latency_1h',  start_offset=>INTERVAL '12 hours', end_offset=>INTERVAL '1 hour',    schedule_interval=>INTERVAL '1 hour',    if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('requests_1h', start_offset=>INTERVAL '12 hours', end_offset=>INTERVAL '1 hour',    schedule_interval=>INTERVAL '1 hour',    if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('spend_1h',    start_offset=>INTERVAL '12 hours', end_offset=>INTERVAL '1 hour',    schedule_interval=>INTERVAL '1 hour',    if_not_exists=>TRUE);
SELECT add_continuous_aggregate_policy('limits_1h',   start_offset=>INTERVAL '12 hours', end_offset=>INTERVAL '1 hour',    schedule_interval=>INTERVAL '1 hour',    if_not_exists=>TRUE);

-- ================= COMPRESSION ON CAGG TABLES =================
ALTER MATERIALIZED VIEW tokens_1m   SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW latency_1m  SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW requests_1m SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW spend_1m    SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW limits_1m   SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
SELECT add_compression_policy('tokens_1m',   compress_after=>INTERVAL '7 days',  if_not_exists=>TRUE);
SELECT add_compression_policy('latency_1m',  compress_after=>INTERVAL '7 days',  if_not_exists=>TRUE);
SELECT add_compression_policy('requests_1m', compress_after=>INTERVAL '7 days',  if_not_exists=>TRUE);
SELECT add_compression_policy('spend_1m',    compress_after=>INTERVAL '7 days',  if_not_exists=>TRUE);
SELECT add_compression_policy('limits_1m',   compress_after=>INTERVAL '7 days',  if_not_exists=>TRUE);

ALTER MATERIALIZED VIEW tokens_5m   SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW latency_5m  SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW requests_5m SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW spend_5m    SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW limits_5m   SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
SELECT add_compression_policy('tokens_5m',   compress_after=>INTERVAL '14 days', if_not_exists=>TRUE);
SELECT add_compression_policy('latency_5m',  compress_after=>INTERVAL '14 days', if_not_exists=>TRUE);
SELECT add_compression_policy('requests_5m', compress_after=>INTERVAL '14 days', if_not_exists=>TRUE);
SELECT add_compression_policy('spend_5m',    compress_after=>INTERVAL '14 days', if_not_exists=>TRUE);
SELECT add_compression_policy('limits_5m',   compress_after=>INTERVAL '14 days', if_not_exists=>TRUE);

ALTER MATERIALIZED VIEW tokens_1h   SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW latency_1h  SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW requests_1h SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW spend_1h    SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
ALTER MATERIALIZED VIEW limits_1h   SET (timescaledb.compress=TRUE, timescaledb.compress_segmentby='api_provider', timescaledb.compress_orderby='bucket DESC');
SELECT add_compression_policy('tokens_1h',   compress_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_compression_policy('latency_1h',  compress_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_compression_policy('requests_1h', compress_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_compression_policy('spend_1h',    compress_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_compression_policy('limits_1h',   compress_after=>INTERVAL '30 days', if_not_exists=>TRUE);

-- ================= RETENTION ON CAGG UNDERLYING TABLES =================
-- 1m -> 30 days; 5m -> 90 days; 1h -> 90 days
SELECT add_retention_policy('tokens_1m',   drop_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_retention_policy('latency_1m',  drop_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_retention_policy('requests_1m', drop_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_retention_policy('spend_1m',    drop_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_retention_policy('limits_1m',   drop_after=>INTERVAL '30 days', if_not_exists=>TRUE);
SELECT add_retention_policy('tokens_5m',   drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('latency_5m',  drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('requests_5m', drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('spend_5m',    drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('limits_5m',   drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('tokens_1h',   drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('latency_1h',  drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('requests_1h', drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('spend_1h',    drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);
SELECT add_retention_policy('limits_1h',   drop_after=>INTERVAL '90 days', if_not_exists=>TRUE);

COMMIT;
