-- ============================================================================
-- wipe_merged_tokens.sql — APPROVED DATA WIPE (dev only)
--
-- APPROVED DATA WIPE (dev only): removes legacy merged 'tokens' hypertable +
-- its continuous aggregates. Old merged token data is intentionally discarded;
-- no backfill.
--
-- Context: 005_token_families.sql replaces the merged `tokens` family with five
-- per-metric-family hypertables (input_tokens, output_tokens, cached_tokens,
-- reasoning_tokens, total_tokens). The old merged rows are deliberately thrown
-- away (dev system, user-approved). No backfill is performed.
--
-- WHY THIS FILE IS NOT IN migrations/: files in infra/db/migrations/ auto-run on
-- fresh DB init. This is a one-time, destructive, human-approved cleanup, so it
-- lives outside migrations/ and is run MANUALLY:
--   docker exec -i prismschism-db psql -v ON_ERROR_STOP=1 -U litellm -d litellm < infra/db/wipe_merged_tokens.sql
--
-- Idempotent: every statement uses IF EXISTS, so re-running is a safe no-op.
-- The continuous aggregates from 003 are dropped BEFORE the table because
-- tokens_1m / tokens_5m / tokens_1h depend on `tokens`.
--
-- NOTE: On a FRESH database, 001_schema.sql still creates an empty `tokens`
-- table; it remains until this wipe is run.
-- ============================================================================

BEGIN;

-- 1. Continuous aggregates built on the merged `tokens` table (003)
DROP MATERIALIZED VIEW IF EXISTS tokens_1m;
DROP MATERIALIZED VIEW IF EXISTS tokens_5m;
DROP MATERIALIZED VIEW IF EXISTS tokens_1h;

-- 2. The legacy merged `tokens` hypertable (created in 001, configured in 002).
--    CASCADE also clears any residual dependents (policies, views, indexes).
DROP TABLE IF EXISTS tokens CASCADE;

COMMIT;
