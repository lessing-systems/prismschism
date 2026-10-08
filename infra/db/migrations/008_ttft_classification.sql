-- 008: TTFT/ghost classifier verdicts.
--
-- One row per (axis, grp): the API's periodic classifier (runs at start, every
-- TTFT_CLASSIFIER_INTERVAL_MIN, and on any deployment_inventory change) writes
-- per-backend verdicts here:
--   real_hw      — rostered in deployment_inventory with a non-empty api_base.
--                  A metric-only group (in metrics, never inventoried) or an
--                  inventory row without an endpoint is ghost data and must
--                  never enter rate math.
--   share_pct    — estimated uncovered-TTFT seconds as percent of the backend's
--                  raw decode seconds over the classifier window (NULL when not
--                  measurable).
--   corrected    — real_hw AND share_pct > TTFT_CORRECTION_THRESHOLD_PCT
--                  (default 2). The decode_tps series (derivedDiffCtes) reads
--                  this column to decide whether a backend's buckets get the
--                  TTFT estimate subtracted.
-- Rows are replaced wholesale per axis on every run; readers between the
-- DELETE and the INSERT see an empty set, which degrades to uncorrected rates.
CREATE TABLE IF NOT EXISTS ttft_classification (
  axis            text             NOT NULL,
  grp             text             NOT NULL,
  real_hw         boolean          NOT NULL DEFAULT false,
  activity_tokens double precision NOT NULL DEFAULT 0,
  requests        double precision NOT NULL DEFAULT 0,
  ttft_requests   double precision NOT NULL DEFAULT 0,
  share_pct       double precision,
  corrected       boolean          NOT NULL DEFAULT false,
  ghost_reason    text,
  window_seconds  integer          NOT NULL,
  measured_at     timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (axis, grp)
);
