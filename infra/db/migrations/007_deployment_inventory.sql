-- ============================================================================
-- 007_deployment_inventory.sql — Add the deployment inventory / roster table
-- Phase: DB Batch B6 (chunk 3 — deployment inventory / roster DDL)
-- Read by the Go scraper (/model/info).
-- Date: 2026-10-01
--
-- Purpose:
--   The deployment inventory / roster table — one row per LiteLLM backend
--   endpoint, populated by the scraper from /model/info, and used to resolve a
--   physical model_id back to its logical model group. last_alive is the
--   last-known-good timestamp and is never cleared.
--
-- Semantics:
--   Intentionally a PLAIN table, NOT a hypertable: it is a small mutable
--   roster, whereas every other table in this schema is an append-only metric
--   hypertable. Idempotent and safe to re-run: a repeat applies with zero
--   errors and zero changes.
--
-- Scope: DDL only — one CREATE TABLE and one CREATE INDEX. No GRANT, no
--   schema qualification, no DROP, no SELECT.
-- ============================================================================

CREATE TABLE IF NOT EXISTS deployment_inventory (
    model_id     TEXT PRIMARY KEY,
    model_group  TEXT NOT NULL,
    api_base     TEXT,
    raw_model    TEXT,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_alive   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployment_inventory_model_group_idx
    ON deployment_inventory (model_group);
