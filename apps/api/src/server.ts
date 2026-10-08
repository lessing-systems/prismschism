// server.ts — plain node:http API server for the prismschism metrics
// endpoint. No framework (no express/fastify). Mirrors the small-file style of
// apps/web: exported pure functions + a thin request handler.
//
// Public surface (pinned by src/server.test.ts):
//   type QueryFn          — minimal pg-style query function
//   METRICS, GROUPS       — known enum values (mirror apps/web/src/lib/types.ts)
//   TIER_MAP, RANGE_SECONDS, VALUE_COL
//   tierForRange, valueColumn
//   type ValidationResult
//   validateSeriesParams, buildSeriesSql, toPoints, createRequestHandler
//   type DeploymentState, HealthRow
//   buildHealthSql, buildStateByGroup
//   buildBridgeSql, buildLabelToModelIds, attachStates, BridgeRow
//   DEFAULT_TOP_N, resolveTopN, TOP_N, applyTopN
//   DEFAULT_SCRAPE_DOWN_AFTER_MS, resolveScrapeDownAfterMs, SCRAPE_DOWN_AFTER_MS,
//   buildScrapeHealthSql, scrapeStatus, stampScrapeDown, ScrapeHealthRow
//   validateKpiParams, buildKpiTotalSql, buildKpiTotalRawSql, kpiTotal, countHealthyDeployments
//   validateBreakdownParams, buildBreakdownSql, toBreakdown
//
// Conversion boundary: storage
// `NULL` (idle) -> API emits `0`; a *missing row* (down/unknown) is simply
// absent, which the frontend renders as a gap. The API performs this at the
// boundary; the frontend never inspects storage. The "errors" metric has no DB
// backing (by design) — it validates as a known metric but short-circuits
// to an empty series, warning rather than querying. Deployment `state` is served
// from the `deployment_health` table (never fabricated): a missing/empty table
// yields an undefined state, which the frontend renders neutral. Deployment
// `state` reaches request-side series labels through a `model_id` bridge
// derived at query time from the raw hypertables ("join through
// model_id"), never from a hardcoded name map; a missing/failed bridge query
// degrades to direct label lookup only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// --- pg import is isolated so the test file never loads the native binding. ---
// The pure functions and request-handler factory never touch pg; only the
// bootstrap path (see isRunningAsMain) builds a pg Pool. A top-level static
// import is evaluated at module-load time, so it must resolve cleanly even
// when the module is imported by the test suite (isRunningAsMain is false
// there, so the Pool is never actually constructed). @types/pg supplies the
// `Pool` typings, so the import is fully typed.
import { Pool } from "pg";

// ===========================================================================
// Reference constants
// ===========================================================================

/** The metric families (apps/web/src/lib/types.ts `Metric`). */
export const METRICS: readonly string[] = ["requests", "errors", "spend", "tokens", "latency", "decode_tps", "input_tps", "decode_tps_implied", "requests_per_min", "aggregate_output_tps", "request_wall_clock"];

/** Valid group-by keys. Raw-tier columns `model`/`api_provider` are carried
 *  into every cagg; identity columns are not. */
export const GROUPS: readonly string[] = ["model", "api_provider", "model_id"];

/** range -> TimescaleDB cagg bucket tier. 30d is intentionally absent: the
 *  frontend `Range` union is `1h | 24h | 7d`, so no 30d tier is wired. */
export const TIER_MAP: Record<string, string> = {
  "1h": "1m",
  "24h": "5m",
  "7d": "1h",
};

/** range -> look-back window in seconds (the single SQL parameter `$1`). */
export const RANGE_SECONDS: Record<string, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
};

/** metric -> cagg value column. latency is a gauge (average); the counters
 *  aggregate by SUM. `errors` has no DB backing -> undefined. */
export const VALUE_COL: Record<string, string | undefined> = {
  requests: "sum_value",
  errors: undefined,
  spend: "sum_value",
  tokens: "sum_value",
  latency: "avg_value",
  limits: "sum_value",
};

// ===========================================================================
// Types
// ===========================================================================

/** The injected query function: a plain, pg-style query function. The handler
 *  depends only on this minimal callable shape — call `query(sql, params)`,
 *  get back `{ rows }`. The real pg `Pool.query` (typed by @types/pg, whose
 *  `QueryResult.rows` is `any[]`) is structurally compatible with it, and the
 *  test suite substitutes a mock function of the same shape. */
export type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;

/** A raw cagg row as returned by pg. Only the keys the handler reads are typed;
 *  the rest is opaque. `bucket` is a `Date`; `value` may be a string (pg parses
 *  `double precision`/`numeric` as text) or `null`. */
export interface Row {
  bucket: Date;
  value: unknown;
  model?: string | null;
  api_provider?: string | null;
  [key: string]: unknown;
}

/** A normalized, DB-shape-agnostic row ready for `toPoints`. */
export interface PointRow {
  bucket: Date;
  group: string;
  value: unknown;
}

/** A finished series point — matches `MetricPoint` in apps/web/src/lib/types.ts.
 *  `state` is the 4-state wire value (healthy / prefill / idle / error). */
export interface SeriesPoint {
  t: string;
  group: string;
  value: number;
  state?: PointState;
  unit?: string;
  litellm_model_name?: string;
  /** Additive (Phase 2 D1): true when the group exists in `deployment_inventory`
   *  (the roster), false when it only appears in the metric tables — e.g. a
   *  retired model_id still inside the window. Optional and only set when the
   *  query actually emitted it, so the current web is unaffected (Phase 3 uses it). */
  in_inventory?: boolean;
  /** Additive (Phase 2 D5): true when the point was SYNTHESIZED by the API rather
   *  than measured — currently only the scrape-down stamping, which replaces an
   *  untrustworthy value with 0 + `state: "error"` because a dead scrape means we
   *  know NOTHING, not that the fleet was idle. A synthetic zero is NOT a
   *  measurement: it must be excluded from ranking, averaging and top-N ordering
   *  (see `applyTopN`). Absent on every genuine point. */
  synthetic?: boolean;
}

/** Discriminated result of `validateSeriesParams`. The `ok: true` branch carries
 *  exactly { ok, metric, range, group } (deep-equality pinned by the test). */
export type ValidationResult =
  | { ok: true; metric: string; range: string; group: string }
  | { ok: false; error: string };

// ===========================================================================
// Pure functions
// ===========================================================================

/** range -> cagg bucket tier, or `undefined` for an unknown range. */
export function tierForRange(range: string): string | undefined {
  return TIER_MAP[range];
}

/** metric -> cagg value column, or `undefined` when the metric has no DB
 *  backing (currently only `errors`). */
export function valueColumn(metric: string): string | undefined {
  return VALUE_COL[metric];
}

/** Validate the `/api/series` query params. Checks in a fixed order —
 *  metric, then range, then group — and names the offending parameter in the
 *  error. `group` is REQUIRED by this endpoint (missing group -> invalid). */
export function validateSeriesParams(query: {
  metric?: string;
  range?: string;
  group?: string;
}): ValidationResult {
  const metric = query.metric;
  if (typeof metric !== "string" || metric.length === 0) {
    return { ok: false, error: "missing or invalid metric" };
  }
  if (!METRICS.includes(metric)) {
    return { ok: false, error: `unknown metric: ${metric}` };
  }

  const range = query.range;
  if (typeof range !== "string" || range.length === 0) {
    return { ok: false, error: "missing or invalid range" };
  }
  if (!Object.prototype.hasOwnProperty.call(RANGE_SECONDS, range)) {
    return { ok: false, error: `unknown range: ${range}` };
  }

  const group = query.group;
  if (typeof group !== "string" || group.length === 0) {
    return { ok: false, error: "missing or invalid group" };
  }
  if (!GROUPS.includes(group)) {
    return { ok: false, error: `unknown group: ${group}` };
  }

  return { ok: true, metric, range, group };
}

/** Build the parameterized cagg query. `family`, `tier` and `group` are
 *  whitelisted identifiers — interpolated ONLY after validation (see the
 *  handler), never from raw user input. The look-back window is bound as `$1`. */
export function buildSeriesSql(metric: string, tier: string, group: string): string {
  const valueCol = valueColumn(metric);
  const summand = valueCol ? `SUM(${valueCol})` : "0";
  return (
    `SELECT bucket, ${group}, ${summand} AS value ` +
    `FROM ${metric}_${tier} ` +
    `WHERE bucket >= now() - ($1 * interval '1 second') ` +
    `GROUP BY bucket, ${group} ORDER BY bucket`
  );
}

/** Build a RAW-hypertable series query, bucketed by the tier interval. Used when
 *  a metric's continuous aggregate lacks the requested `group` column (e.g. the
 *  `requests_<tier>` cagg has no `model_id`), so grouping by that column must
 *  read the raw hypertable instead of the cagg. `metric` is the raw hypertable
 *  name, `tier`/`group` are whitelisted (DERIVED_INTERVAL / GROUPS) BEFORE
 *  interpolation; unknown input throws. `$1` binds the range seconds, exactly
 *  like buildSeriesSql. */
export function buildRawSeriesSql(metric: string, tier: string, group: string): string {
  const interval = DERIVED_INTERVAL[tier];
  if (interval === undefined) throw new Error(`unknown tier: ${tier}`);
  if (!GROUPS.includes(group)) throw new Error(`unknown group: ${group}`);
  return (
    `SELECT time_bucket(${interval}, ts) AS bucket, ${group}, SUM(value) AS value ` +
    `FROM ${metric} ` +
    `WHERE ts >= now() - ($1 * interval '1 second') AND ${group} IS NOT NULL ` +
    `GROUP BY bucket, ${group} ORDER BY bucket`
  );
}

// ===========================================================================
// Derived deployment metrics (the API is the single derivation point — no rate
// math in the browser; rate/increase math is consumer-side, never
// scraper-computed). These metrics have NO continuous
// aggregate (migration 005 creates none), so their SQL reads the RAW
// hypertables. The stored `value` is ALREADY a per-scrape delta: the scraper
// (apps/scraper/internal/delta/delta.go) differences each monotonic counter
// before insert (~15s scrape cadence), so a bucket's rate is a plain
// SUM(value) per time_bucket — NO LAG, NO re-differencing (that delta-of-delta
// was the ~4x inflation bug), NO SUM(dt). Table and metric names come ONLY from
// the whitelisted DERIVED table below — raw request input is never interpolated.
// ===========================================================================

/** A whitelisted raw-table read source: a table and an optional `metric`
 *  discriminator (the Prometheus name stored on the row). */
export type DerivedSource = { table: string; metric?: string };

/** How a derived metric's denominator is obtained: the bucket's wall-clock
 *  seconds (`bucket_seconds`, e.g. 60 for a 1m bucket), a second summed series
 *  (`series`), or one summed series minus another from the SAME table
 *  (`series_diff`, e.g. upstream latency minus time-to-first-token). */
export type DerivedSpec = {
  unit: "token/s" | "req/min" | "s";
  num: DerivedSource;
  den:
    | { kind: "bucket_seconds" }
    | { kind: "series"; source: DerivedSource }
    | { kind: "series_diff"; source: DerivedSource; minus: DerivedSource };
  /** When true, the `bucket_seconds` denominator is scaled to MINUTES
   *  (bucket seconds / 60: 1m -> 1, 5m -> 5, 1h -> 60), so the value is a
   *  per-minute rate. Unset keeps the per-second denominator untouched. */
  perMinute?: boolean;
};

/** The derived-metric spec table (the ONLY source of table/metric identifiers
 *  for derived SQL). Grouped by `model_id` (the deployment identity). */
export const DERIVED: Record<string, DerivedSpec> = {
  // Decode speed: output tokens over the time spent DECODING them. Per request,
  // upstream LLM-API latency = TTFT (queue + prefill + first token) + decode, so
  // Σ(llm_api_latency_sum) − Σ(time_to_first_token_sum) over a bucket is the
  // summed decode seconds of the requests that completed in it. Output tokens and
  // both histograms are recorded at request completion, so they land in the same
  // scrape/bucket. The result is the token-weighted PER-STREAM decode rate (two
  // concurrent streams add their decode seconds, not wall-clock). TTFT is only
  // observed for streaming calls — a non-streaming request's prefill would stay
  // in the denominator and bias that bucket low. Whether that bias is worth
  // correcting is measured PER BACKEND over the served window: if a backend's
  // estimated uncovered-TTFT share exceeds TTFT_CORRECTION_THRESHOLD_PCT
  // (docker env, default 2%), its buckets get the estimate subtracted; below
  // the threshold the raw difference is kept as-is (within margin of error).
  // See derivedDiffCtes for the estimate itself.
  // (Previously Σ output tokens / bucket wall-clock seconds: that is average
  // output throughput incl. idle, queue and prefill time — not a decode rate.
  // That frame now exists as `aggregate_output_tps`.)
  decode_tps: {
    unit: "token/s",
    num: { table: "output_tokens" },
    den: {
      kind: "series_diff",
      source: { table: "latency", metric: "litellm_llm_api_latency_metric_sum" },
      minus: { table: "latency", metric: "litellm_llm_api_time_to_first_token_metric_sum" },
    },
  },
  input_tps: {
    unit: "token/s",
    num: { table: "input_tokens" },
    den: { kind: "bucket_seconds" },
  },
  decode_tps_implied: {
    unit: "token/s",
    num: { table: "latency", metric: "litellm_deployment_latency_per_output_token_count" },
    den: { kind: "series", source: { table: "latency", metric: "litellm_deployment_latency_per_output_token_sum" } },
  },
  // Request rate per backend (D3). The `requests_<tier>` caggs group by model +
  // api_provider only and carry NO model_id, so this reads the raw `requests`
  // hypertable (which does carry model_id); the derived path is already
  // raw-table and roster-driven.
  requests_per_min: {
    unit: "req/min",
    num: { table: "requests" },
    den: { kind: "bucket_seconds" },
    perMinute: true,
  },
  // TRUE FLEET AGGREGATE output rate: Σ output tokens over the bucket's
  // WALL-CLOCK seconds. The only frame in which a multi-backend sum is
  // concurrency-inclusive and physically comparable: two streams decoding
  // simultaneously are 2× the tokens in the same 60 s, not 2× the decode
  // seconds. TTFT never enters this calculation — the denominator is wall-clock,
  // so prefill/queue time is legitimately "seconds in which the fleet emitted no
  // tokens" (a per-stream rate would subtract TTFT; an aggregate must not).
  // Ghost-proofing lives client-side: the web tile sums only rostered
  // (in_inventory !== false), unassigned-filtered groups of this series.
  aggregate_output_tps: {
    unit: "token/s",
    num: { table: "output_tokens" },
    den: { kind: "bucket_seconds" },
  },
  // Mean END-TO-END wall-clock seconds per request: Σ request-total-latency
  // over the requests that completed in the bucket. Queue, prefill, TTFT and
  // decode all count — this is the "how long does a task take on this backend"
  // figure, so smaller is better, but it also scales with the workload's
  // generation length (compare backends on similar tasks). Idle buckets have
  // no requests and therefore no point (an absent numerator is not a 0 s
  // request). No TTFT/ghost correction applies: nothing here is a rate.
  request_wall_clock: {
    unit: "s",
    num: { table: "latency", metric: "litellm_request_total_latency_metric_sum" },
    den: {
      kind: "series",
      source: { table: "latency", metric: "litellm_request_total_latency_metric_count" },
    },
  },
};

/** True when `m` is a derived metric (own property of DERIVED). */
export function isDerivedMetric(m: string): boolean {
  return Object.prototype.hasOwnProperty.call(DERIVED, m);
}

/** bucket tier -> TimescaleDB interval literal for time_bucket (whitelisted). */
export const DERIVED_INTERVAL: Record<string, string> = {
  "1m": "INTERVAL '1 minute'",
  "5m": "INTERVAL '5 minutes'",
  "1h": "INTERVAL '1 hour'",
};

/** bucket tier -> wall-clock seconds in one bucket (whitelisted; same tier keys
 *  as DERIVED_INTERVAL). The denominator for a per-scrape-delta column summed
 *  over a bucket is simply the bucket's length in seconds. */
export const DERIVED_BUCKET_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "1h": 3600,
};

/** The last-known-good deployment roster. Rows are NEVER deleted when LiteLLM
 *  becomes unreachable, so this table — not the metric hypertables — is the
 *  authoritative set of backends that are supposed to appear in a series. The
 *  derived row set is driven from here. */
export const INVENTORY_TABLE = "deployment_inventory";

/** The literal the scraper stores for a backend with no LiteLLM model group. It
 *  is a FIRST-CLASS group value: the API must NEVER filter it out of a response.
 *  Whether unassigned backends are shown is a web build-time flag, not an API
 *  concern. */
export const UNASSIGNED_GROUP = "unassigned";

/** group axis -> the `deployment_inventory` column holding that axis's value. The
 *  metric hypertables carry the model group in their own `model` column while
 *  the roster stores it in `model_group`, so the join key for axis `model` is
 *  `model_group`. `api_provider` deliberately has NO inventory axis — the roster
 *  is per-deployment — so that axis keeps metric-only behavior. Every
 *  interpolated identifier comes from THIS const map, never from request input. */
export const INVENTORY_GROUP_COL: Record<string, string> = {
  model_id: "model_id",
  model: "model_group",
};

/** bucket tier -> the date_trunc unit that makes a generate_series bucket grid
 *  land on the SAME boundaries as time_bucket for that tier: the unix epoch is
 *  hour-aligned, so a 5m grid stepped from an hour-truncated start stays on 5m
 *  boundaries, and 1h is hour-aligned. Whitelisted; never request input. */
export const DERIVED_TRUNC: Record<string, string> = {
  "1m": "minute",
  "5m": "hour",
  "1h": "hour",
};

/** The roster row set for a group axis, as a single `grp` column: one row per
 *  deployment (`model_id`) or one row per model group (`model`, DISTINCT because
 *  the roster is per-deployment). Returns "" for an axis with no inventory column
 *  (`api_provider`), which then keeps metric-only behavior. `group` is validated
 *  against GROUPS before this runs and the column comes from INVENTORY_GROUP_COL,
 *  so nothing request-controlled is interpolated. */
export function buildRosterSql(group: string): string {
  const col = INVENTORY_GROUP_COL[group];
  if (col === undefined) return "";
  const distinct = col === "model_group" ? "DISTINCT " : "";
  return `SELECT ${distinct}${col} AS grp FROM ${INVENTORY_TABLE}`;
}

/** One row of `buildInventoryGroupsSql`. */
export type InventoryGroupRow = { grp: unknown };

/** The inventory group set for a group axis, as a single `grp` column: the groups
 *  the top-N cap must NEVER truncate (D1 — inventory rows are exempt from the cap).
 *  Returns "" for an axis with no inventory axis (`api_provider`) so the caller
 *  skips the round-trip entirely. The column comes from INVENTORY_GROUP_COL only,
 *  so nothing request-controlled is interpolated. */
export function buildInventoryGroupsSql(group: string): string {
  const col = INVENTORY_GROUP_COL[group];
  if (col === undefined) return "";
  return `SELECT DISTINCT ${col} AS grp FROM ${INVENTORY_TABLE} WHERE ${col} IS NOT NULL`;
}

/** One source's summed activity CTE (`<p>agg`): the raw `value` column is
 *  ALREADY a per-scrape delta (delta.go differenced it before insert), so a
 *  bucket's activity total is a plain SUM(value) grouped by time_bucket — no
 *  LAG, no re-differencing (that is the delta-of-delta bug already fixed for the
 *  derived rate metrics via derivedSumCtes). Unlike derivedSumCtes there is
 *  deliberately NO `HAVING SUM(value) > 0`: a live-but-quiet bucket whose stored
 *  deltas sum to 0 MUST still emit a row so it can classify `idle` (a ~5-min idle
 *  heartbeat means a quiet model still produces rows; NO ROW means the scrape
 *  failed and must NOT be fabricated into idle).
 *  `p` is the CTE name prefix ("n"/"r"/"t"). */
function activitySourceCtes(p: string, source: DerivedSource, group: string, interval: string): string {
  const metricFilter = source.metric ? ` AND metric = '${source.metric}'` : "";
  return (
    `${p}agg AS (` +
    `SELECT time_bucket(${interval}, ts) AS bucket, ${group}, SUM(value) AS v ` +
    `FROM ${source.table} ` +
    `WHERE ts >= now() - ($1 * interval '1 second') AND ${group} IS NOT NULL${metricFilter} ` +
    `GROUP BY bucket, ${group})`
  );
}

/** One source's summed CTE (`<p>agg`): the raw `value` column is ALREADY a
 *  per-scrape delta (delta.go differenced it before insert), so a bucket's total
 *  is a plain SUM(value) grouped by time_bucket — no LAG, no re-differencing.
 *  There is deliberately NO `HAVING SUM(value) > 0` here: a bucket whose stored
 *  deltas sum to 0 is a REAL idle bucket (alive, no traffic) and must survive so
 *  the roster join in buildDerivedSql can render it as 0 rather than a gap. A
 *  bucket with no rows at all is already covered by the dense bucket/roster grid,
 *  which supplies the 0 — so nothing here may drop anything.
 *  `p` is the CTE name prefix ("n"/"d"). */
function derivedSumCtes(p: string, source: DerivedSource, group: string, interval: string): string {
  const metricFilter = source.metric ? ` AND metric = '${source.metric}'` : "";
  return (
    `${p}agg AS (` +
    `SELECT time_bucket(${interval}, ts) AS bucket, ${group}, SUM(value) AS v ` +
    `FROM ${source.table} ` +
    `WHERE ts >= now() - ($1 * interval '1 second') AND ${group} IS NOT NULL${metricFilter} ` +
    `GROUP BY bucket, ${group})`
  );
}

/** The `series_diff` denominator CTE (`dagg`): per bucket and group,
 *  SUM(source) − SUM(minus), both read from the same whitelisted table in one
 *  pass. A bucket with no `minus` rows subtracts 0; a bucket with no `source`
 *  rows yields NULL (unknowable, skipped by derivedPoints unless num is 0). */
/** Parse the TTFT-correction threshold (percent) from docker env. Unset, empty
 *  or non-numeric falls back to the documented default of 2; a negative value
 *  is invalid and also falls back. 0 means "correct every backend with any
 *  uncovered TTFT"; a huge value (e.g. 1e9) disables the correction entirely. */
export function parseThresholdPct(raw: string | undefined): number {
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 2;
}

/** Backend-level gate for the TTFT-coverage correction, in PERCENT of that
 *  backend's decode seconds (docker env TTFT_CORRECTION_THRESHOLD_PCT, default
 *  2). A backend whose estimated uncovered-TTFT share is at or below the
 *  threshold is within margin of error and keeps its raw denominator; above it,
 *  the estimate is subtracted from its buckets. */
export const TTFT_CORRECTION_THRESHOLD_PCT = parseThresholdPct(
  process.env.TTFT_CORRECTION_THRESHOLD_PCT,
);

function derivedDiffCtes(
  source: DerivedSource,
  minus: DerivedSource,
  group: string,
  interval: string,
): string {
  if (source.table !== minus.table || !source.metric || !minus.metric) {
    throw new Error("series_diff needs two metrics of one table");
  }
  const base =
    `SUM(value) FILTER (WHERE metric = '${source.metric}') - ` +
    `COALESCE(SUM(value) FILTER (WHERE metric = '${minus.metric}'), 0)`;
  let vExpr = base;
  let metricFilter = `'${source.metric}', '${minus.metric}'`;

  // FIX (TTFT coverage): TTFT is a STREAMING-only counter. When a bucket also
  // holds non-streaming requests (latency_count > ttft_count), their prefill
  // stays in `base` and biases that bucket's decode rate LOW — measured on this
  // fleet: one Strix-Halo backend -7.2% (20 s mean TTFT), the Spark pair only
  // -0.03% (~90 ms TTFT). The aggregates cannot say WHICH requests lacked TTFT, so subtract
  // an ESTIMATE: uncovered-request count × the bucket's own mean covered TTFT
  // (Σttft / Σttft_count). Slightly inaccurate by design but always closer to
  // the true decode seconds than leaving their whole latency in. Whether a
  // backend is corrected at all is NOT decided here: the periodic classifier
  // (runTtftClassifier) measures each backend's uncovered-TTFT share and ghosts,
  // and stores a per-(axis, grp) `corrected` verdict in ttft_classification —
  // run at API start, every TTFT_CLASSIFIER_INTERVAL_MIN, and whenever the
  // deployment_inventory fingerprint changes (new/updated model at LiteLLM).
  // The join is a LEFT JOIN: an unclassified backend (empty table, fresh DB)
  // simply keeps its raw base. Guards:
  //   - no covered requests in the bucket (ttft_count = 0) -> mean undefined ->
  //     no subtraction, base is all we have;
  //   - the estimate would eat the entire base (sparse bucket where uncovered
  //     requests are much shorter than covered ones) -> keep base rather than
  //     invent a <= 0 denominator (a skipped bucket loses real decode data).
  // Count metrics follow the LiteLLM histogram convention (`_sum` -> `_count`).
  // A spec whose metrics do not simply degrades to the plain difference: the
  // count FILTERs sum to NULL -> COALESCE 0 -> missing 0.
  if (source.metric.endsWith("_sum") && minus.metric.endsWith("_sum")) {
    const srcCount = `${source.metric.slice(0, -"_sum".length)}_count`;
    const minusCount = `${minus.metric.slice(0, -"_sum".length)}_count`;
    metricFilter += `, '${srcCount}', '${minusCount}'`;
    const vExpr =
      `CASE WHEN c.corrected ` +
      `AND d.ttft_n > 0 AND d.est > 0 AND d.est < d.base ` +
      `THEN d.base - d.est ELSE d.base END`;
    return (
      `dagg AS (` +
      `SELECT d.bucket, d.${group}, ${vExpr} AS v FROM (` +
      `SELECT time_bucket(${interval}, ts) AS bucket, ${group}, ` +
      `${base} AS base, ` +
      `COALESCE(SUM(value) FILTER (WHERE metric = '${minusCount}'), 0) AS ttft_n, ` +
      `GREATEST(COALESCE(SUM(value) FILTER (WHERE metric = '${srcCount}'), 0) ` +
      `- COALESCE(SUM(value) FILTER (WHERE metric = '${minusCount}'), 0), 0) * ` +
      `COALESCE(SUM(value) FILTER (WHERE metric = '${minus.metric}') ` +
      `/ NULLIF(SUM(value) FILTER (WHERE metric = '${minusCount}'), 0), 0) AS est ` +
      `FROM ${source.table} ` +
      `WHERE ts >= now() - ($1 * interval '1 second') AND ${group} IS NOT NULL ` +
      `AND metric IN (${metricFilter}) ` +
      `GROUP BY bucket, ${group}) d ` +
      `LEFT JOIN ttft_classification c ON c.axis = '${group}' AND c.grp = d.${group})`
    );
  }
  return (
    `dagg AS (` +
    `SELECT time_bucket(${interval}, ts) AS bucket, ${group}, ` +
    `${vExpr} AS v ` +
    `FROM ${source.table} ` +
    `WHERE ts >= now() - ($1 * interval '1 second') AND ${group} IS NOT NULL ` +
    `AND metric IN (${metricFilter}) ` +
    `GROUP BY bucket, ${group})`
  );
}

// ===========================================================================
// TTFT/ghost classifier — per-backend verdicts, run periodically
// ===========================================================================

/** Parse a non-negative number from docker env with a fallback. Unset, empty,
 *  whitespace, non-numeric or negative input yields the fallback (Number('') is
 *  0, so emptiness is checked before the numeric parse). */
export function parseEnvNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** How often the classifier re-measures backends, in minutes (docker env
 *  TTFT_CLASSIFIER_INTERVAL_MIN, default 120 = the "every 2 hours" cadence).
 *  0 disables the periodic run; the start run and the inventory watch remain. */
export const TTFT_CLASSIFIER_INTERVAL_MIN = parseEnvNumber(
  process.env.TTFT_CLASSIFIER_INTERVAL_MIN,
  120,
);

/** How far back the classifier measures a backend, in minutes (docker env
 *  TTFT_CLASSIFIER_WINDOW_MIN, default 1440 = 24h — long enough to average
 *  streaming/non-streaming mix, short enough to track a fleet whose traffic
 *  changes). */
export const TTFT_CLASSIFIER_WINDOW_SECONDS =
  parseEnvNumber(process.env.TTFT_CLASSIFIER_WINDOW_MIN, 1440) * 60;

/** How often the classifier polls the deployment_inventory fingerprint for a
 *  new/updated model at LiteLLM, in seconds (docker env
 *  TTFT_CLASSIFIER_WATCH_S, default 60). 0 disables the watch. */
export const TTFT_CLASSIFIER_WATCH_S = parseEnvNumber(
  process.env.TTFT_CLASSIFIER_WATCH_S,
  60,
);

/** Axes the classifier classifies (the inventory-backed group axes). */
export const TTFT_CLASSIFIER_AXES: readonly string[] = ["model_id", "model"];

/** The per-backend classifier INSERT. For every group seen in the window's
 *  metrics OR the roster it writes one verdict row:
 *    real_hw    — rostered in deployment_inventory WITH a non-empty api_base:
 *                 a real hardware backend. A metric-only group (appears in
 *                 metrics but was never inventoried — the "ghost data" case)
 *                 or an inventory row without an endpoint is NOT real and is
 *                 never corrected (ghosts must not enter any rate math).
 *    share_pct  — estimated uncovered-TTFT seconds as a percent of the
 *                 backend's raw decode seconds over the window (NULL when not
 *                 measurable: no requests, or no decode seconds).
 *    corrected  — real_hw AND share_pct > threshold: the backend mixes in
 *                 enough non-streaming traffic that its decode buckets need
 *                 the TTFT estimate subtracted (see derivedDiffCtes).
 *    ghost_reason — NULL for real backends; else why it was classified a ghost.
 * `$1` binds the window seconds, `$2` the threshold percent. `axis` must be a
 * whitelisted inventory axis (INVENTORY_GROUP_COL) before interpolation. */
export function buildTtftClassifierSql(axis: string, windowSeconds: number, thresholdPct: number): string {
  const col = INVENTORY_GROUP_COL[axis];
  if (col === undefined) throw new Error(`no inventory axis: ${axis}`);
  const latSum = "litellm_llm_api_latency_metric_sum";
  const ttftSum = "litellm_llm_api_time_to_first_token_metric_sum";
  const latCount = "litellm_llm_api_latency_metric_count";
  const ttftCount = "litellm_llm_api_time_to_first_token_metric_count";
  const realExpr =
    `a.in_inv AND EXISTS (SELECT 1 FROM deployment_inventory i ` +
    `WHERE i.${col} = a.grp AND COALESCE(i.api_base, '') <> '')`;
  return (
    `INSERT INTO ttft_classification ` +
    `(axis, grp, real_hw, activity_tokens, requests, ttft_requests, share_pct, corrected, ghost_reason, window_seconds) ` +
    `WITH lat AS (` +
    // The metric hypertables carry the group in a column named like the AXIS
    // (`model` / `model_id`); only deployment_inventory renames it
    // (INVENTORY_GROUP_COL), so the metric CTEs group by the axis name while
    // the roster/real-hardware checks use the inventory column.
    `SELECT ${axis} AS grp, ` +
    `SUM(value) FILTER (WHERE metric = '${latSum}') AS lat_s, ` +
    `SUM(value) FILTER (WHERE metric = '${ttftSum}') AS ttft_s, ` +
    `SUM(value) FILTER (WHERE metric = '${latCount}') AS lat_n, ` +
    `SUM(value) FILTER (WHERE metric = '${ttftCount}') AS ttft_n ` +
    `FROM latency WHERE ts >= now() - ($1 * interval '1 second') AND ${axis} IS NOT NULL ` +
    `AND metric IN ('${latSum}', '${ttftSum}', '${latCount}', '${ttftCount}') GROUP BY 1), ` +
    `tok AS (SELECT ${axis} AS grp, SUM(value) AS tokens FROM output_tokens ` +
    `WHERE ts >= now() - ($1 * interval '1 second') AND ${axis} IS NOT NULL GROUP BY 1), ` +
    // bool_or, NOT a bare UNION of (grp, in_inv) rows: a group that is BOTH
    // inventoried and emitting metrics would land twice — (grp, true) and
    // (grp, false) — and violate the (axis, grp) primary key. This is the same
    // union-of-flags shape as the 2x max-tile bug in buildDerivedSql.
    `allg AS (SELECT grp, bool_or(in_inv) AS in_inv FROM (` +
    `SELECT i.${col} AS grp, true AS in_inv FROM deployment_inventory i WHERE i.${col} IS NOT NULL ` +
    `UNION ALL SELECT lat.grp, false FROM lat ` +
    `UNION ALL SELECT tok.grp, false FROM tok) u GROUP BY grp), ` +
    `s AS (SELECT a.grp, a.in_inv, ${realExpr} AS real_hw, ` +
    `COALESCE(t.tokens, 0) AS tokens, COALESCE(l.lat_n, 0) AS lat_n, ` +
    `COALESCE(l.ttft_n, 0) AS ttft_n, ` +
    `CASE WHEN COALESCE(l.lat_n, 0) > 0 AND COALESCE(l.lat_s, 0) - COALESCE(l.ttft_s, 0) > 0 ` +
    `THEN 100.0 * GREATEST(COALESCE(l.lat_n, 0) - COALESCE(l.ttft_n, 0), 0) ` +
    `* COALESCE(l.ttft_s / NULLIF(l.ttft_n, 0), 0) ` +
    `/ (l.lat_s - COALESCE(l.ttft_s, 0)) ELSE NULL END AS share_pct ` +
    `FROM allg a LEFT JOIN lat l ON l.grp = a.grp LEFT JOIN tok t ON t.grp = a.grp) ` +
    `SELECT '${axis}', s.grp, s.real_hw, s.tokens, s.lat_n, s.ttft_n, s.share_pct, ` +
    `(s.real_hw AND s.share_pct IS NOT NULL AND s.share_pct > $2), ` +
    `CASE WHEN NOT s.in_inv THEN 'metric-only: no deployment_inventory row' ` +
    `WHEN NOT s.real_hw THEN 'inventory row without api_base' ` +
    `ELSE NULL END, ` +
    `$1 FROM s`
  );
}

/** One axis's classifier result. */
export type TtftClassifyResult = { axis: string; rows: number };

/** Run the classifier for every axis: delete the axis's stale verdicts, then
 *  insert fresh ones. Two statements rather than one atomic CTE because the
 *  DELETE and the INSERT would target the same rows (a same-statement
 *  data-modifying pair on one table risks a unique violation); the worst case
 *  between them is an empty verdict set, which degrades to uncorrected rates.
 *  `query` is the plain QueryFn so tests can stub it. */
export async function runTtftClassifier(
  query: QueryFn,
  opts?: { windowSeconds?: number; thresholdPct?: number; axes?: readonly string[] },
): Promise<TtftClassifyResult[]> {
  const windowSeconds = opts?.windowSeconds ?? TTFT_CLASSIFIER_WINDOW_SECONDS;
  const thresholdPct = opts?.thresholdPct ?? TTFT_CORRECTION_THRESHOLD_PCT;
  const axes = opts?.axes ?? TTFT_CLASSIFIER_AXES;
  const results: TtftClassifyResult[] = [];
  for (const axis of axes) {
    await query(`DELETE FROM ttft_classification WHERE axis = $1`, [axis]);
    await query(buildTtftClassifierSql(axis, windowSeconds, thresholdPct), [
      windowSeconds,
      thresholdPct,
    ]);
    const counted = await query(
      `SELECT count(*)::int AS n FROM ttft_classification WHERE axis = $1`,
      [axis],
    );
    results.push({ axis, rows: Number(counted.rows[0]?.n ?? 0) });
  }
  return results;
}

/** deployment_inventory change fingerprint: row count plus a hash over the
 *  identity columns. A new model at LiteLLM, a moved group or a swapped
 *  raw_model all change it; last_alive churn does not. */
export async function inventoryFingerprint(query: QueryFn): Promise<string> {
  const res = await query(
    `SELECT count(*)::int AS n, ` +
      `COALESCE(md5(string_agg(model_id || '|' || COALESCE(model_group, '') || '|' || COALESCE(raw_model, ''), ',' ORDER BY model_id)), '') AS fp ` +
      `FROM deployment_inventory`,
    [],
  );
  const row = res.rows[0] as { n?: number; fp?: string } | undefined;
  return `${row?.n ?? 0}:${row?.fp ?? ""}`;
}

/** The scheduler: classify once at start, then every
 *  TTFT_CLASSIFIER_INTERVAL_MIN minutes, and re-classify early whenever the
 *  deployment_inventory fingerprint changes (new/updated model at LiteLLM —
 *  polled every TTFT_CLASSIFIER_WATCH_S seconds). Runs never overlap; a failed
 *  run is logged and retried on the next trigger. Returns a stop() for tests. */
export function startTtftClassifierScheduler(query: QueryFn): { stop: () => void } {
  let running = false;
  let lastFingerprint: string | null = null;
  let lastRunOk = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  const run = (why: string): void => {
    if (running) return;
    running = true;
    void runTtftClassifier(query)
      .then((results) => {
        lastRunOk = true;
        console.log(
          `ttft classifier (${why}): ` +
            results.map((r) => `${r.axis}=${r.rows} backends`).join(", "),
        );
      })
      .catch((err: unknown) => {
        lastRunOk = false;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`ttft classifier (${why}) failed:`, message);
      })
      .finally(() => {
        running = false;
      });
  };
  run("start");
  if (TTFT_CLASSIFIER_INTERVAL_MIN > 0) {
    timers.push(setInterval(() => run("interval"), TTFT_CLASSIFIER_INTERVAL_MIN * 60_000));
  }
  if (TTFT_CLASSIFIER_WATCH_S > 0) {
    timers.push(
      setInterval(() => {
        void inventoryFingerprint(query)
          .then((fp) => {
            const first = lastFingerprint === null;
            const changed = !first && fp !== lastFingerprint;
            lastFingerprint = fp;
            // A failed start run is retried as soon as the DB answers at all.
            if (changed || (first && !lastRunOk)) run(changed ? "inventory-change" : "retry");
          })
          .catch(() => {
            /* inventory not reachable yet; the interval run will catch up */
          });
      }, TTFT_CLASSIFIER_WATCH_S * 1000),
    );
  }
  return {
    stop: () => timers.forEach((t) => clearInterval(t)),
  };
}

/** Build the derived-metric query. `metric`/`tier`/`group` are whitelisted
 *  (DERIVED / DERIVED_INTERVAL / DERIVED_TRUNC / GROUPS) BEFORE interpolation;
 *  unknown input throws. `$1` is bound to the range seconds, exactly like
 *  buildSeriesSql. The final SELECT emits `bucket`, a column literally named the
 *  `group` value, and `num`/`den`.
 *
 *  Roster-driven (the point of this query): when the axis has an inventory column
 *  the row set is `buckets CROSS JOIN roster`, NOT whatever the metric
 *  hypertables happen to contain. The dense generate_series grid is deliberate:
 *  every rostered backend renders in every bucket of the window, so a backend
 *  with no metric rows returns value 0 instead of vanishing, and an interior
 *  scrape gap renders as 0 instead of a hole in the line. Telling a genuinely
 *  dead scrape apart from an idle backend is NOT done here — that is scrape-down
 *  stamping (D5, next package); here an absent numerator is simply 0.
 *
 *  A `series` denominator LEFT-joins its CTE: a bucket with a numerator but no
 *  denominator has a genuinely unknowable rate (den NULL) and derivedPoints skips
 *  it — that is not a zero. */
export function buildDerivedSql(metric: string, tier: string, group: string): string {
  if (!isDerivedMetric(metric)) throw new Error(`not a derived metric: ${metric}`);
  if (!GROUPS.includes(group)) throw new Error(`unknown group: ${group}`);
  const interval = DERIVED_INTERVAL[tier];
  if (interval === undefined) throw new Error(`unknown tier: ${tier}`);
  const bucketSeconds = DERIVED_BUCKET_SECONDS[tier];
  if (bucketSeconds === undefined) throw new Error(`unknown tier: ${tier}`);
  const trunc = DERIVED_TRUNC[tier];
  if (trunc === undefined) throw new Error(`unknown tier: ${tier}`);

  const spec = DERIVED[metric];
  const isSeries = spec.den.kind === "series" || spec.den.kind === "series_diff";
  const numCtes = derivedSumCtes("n", spec.num, group, interval);
  const denCtes =
    spec.den.kind === "series"
      ? derivedSumCtes("d", spec.den.source, group, interval)
      : spec.den.kind === "series_diff"
        ? derivedDiffCtes(spec.den.source, spec.den.minus, group, interval)
        : "";
  // `bucket_seconds` -> the constant wall-clock seconds of one bucket (the
  // numerator is a per-scrape-delta column summed over the bucket); `series` ->
  // the second summed CTE, left NULL when the bucket has no rows for it.
  // `perMinute` scales the constant to minutes (1m -> 1, 5m -> 5, 1h -> 60) so
  // the value is a per-MINUTE rate; every other spec keeps raw seconds unchanged.
  const denExpr = isSeries ? "d.v" : `${spec.perMinute ? bucketSeconds / 60 : bucketSeconds}`;
  const roster = buildRosterSql(group);

  // No inventory axis (`api_provider`): metric-only and nagg-driven — no roster,
  // no bucket spine, because that axis is not per-deployment.
  if (roster === "") {
    if (!isSeries) {
      return (
        `WITH ${numCtes} ` +
        `SELECT n.bucket AS bucket, n.${group} AS ${group}, n.v AS num, ${denExpr} AS den ` +
        `FROM nagg n ORDER BY n.bucket`
      );
    }
    return (
      `WITH ${numCtes}, ${denCtes} ` +
      `SELECT n.bucket AS bucket, n.${group} AS ${group}, n.v AS num, ${denExpr} AS den ` +
      `FROM nagg n JOIN dagg d ON d.bucket = n.bucket AND d.${group} = n.${group} ` +
      `ORDER BY n.bucket`
    );
  }

  // `unassigned` is a first-class group value: the roster selects EVERY inventory
  // row, including the scraper's literal `unassigned` model group, and nothing
  // downstream filters it out (hiding it is a web build-time flag).
  // The row set is roster UNION metric, not roster alone. A pure
  // `buckets CROSS JOIN roster` spine silently DROPS any group that emits metrics
  // but is absent from deployment_inventory — a retired model_id still inside a
  // 7d window would vanish from the series entirely. `allgroups` keeps every
  // rostered group (inv = true, so the top-N cap exempts it) AND every metric-only
  // group (inv = false, so the cap may truncate it).
  const rosterCte = `roster AS (${roster})`;
  const bucketsCte =
    `buckets AS (SELECT generate_series(date_trunc('${trunc}', now() - ($1 * interval '1 second')), ` +
    `now(), ${interval}) AS bucket)`;
  const allgroupsCte =
    // FIX (2x dup): this used to be a bare `roster UNION (SELECT DISTINCT grp,
    // false FROM nagg)`. UNION dedupes on the WHOLE row (grp, inv), so a group
    // that is BOTH inventoried and emitting metrics — every live deployment —
    // produced TWO rows in allgroups: (grp, true) and (grp, false). The buckets
    // CROSS JOIN then emitted TWO byte-identical points per (bucket, group), and
    // any consumer that sums the raw series per bucket (the web's
    // maxCombinedTokenRate, i.e. the "Max Combined Token/s (ever)" tile) counted
    // every deployment twice: measured 2.000x inflation on both decode_tps and
    // input_tps. Collapsing to ONE row per group with `bool_or(inv)` restores the
    // intended flag semantics: true iff the group is rostered, false iff
    // metric-only.
    `allgroups AS (SELECT grp, bool_or(inv) AS inv FROM (` +
    `SELECT grp, true AS inv FROM roster ` +
    `UNION ALL SELECT DISTINCT n.${group} AS grp, false AS inv FROM nagg n` +
    `) branches GROUP BY grp)`;
  const denJoin = isSeries ? ` LEFT JOIN dagg d ON d.bucket = b.bucket AND d.${group} = g.grp` : "";
  const denCte = isSeries ? `, ${denCtes}` : "";
  return (
    // nagg/dagg FIRST: `allgroups` reads nagg, so the metric CTEs must precede it.
    `WITH ${numCtes}${denCte}, ${rosterCte}, ${bucketsCte}, ${allgroupsCte} ` +
    `SELECT b.bucket AS bucket, g.grp AS ${group}, g.inv AS in_inventory, ` +
    `COALESCE(n.v, 0) AS num, ${denExpr} AS den ` +
    `FROM buckets b CROSS JOIN allgroups g ` +
    `LEFT JOIN nagg n ON n.bucket = b.bucket AND n.${group} = g.grp${denJoin} ` +
    `ORDER BY b.bucket, g.grp`
  );
}

/** A raw derived-metric row: the group column is normalized to `group` by the
 *  handler; `num`/`den` are the two summed aggregates (pg may return numeric
 *  as text). `in_inventory` is the roster flag from `allgroups.inv` (absent when
 *  the query did not emit it, i.e. the no-roster `api_provider` branch). */
export type DerivedRow = {
  bucket: Date | string;
  group: string;
  num: unknown;
  den: unknown;
  in_inventory?: boolean | null;
};

/** Attach the additive roster flag to a point, and ONLY when the row actually
 *  carried it: a caller that never selected `in_inventory` keeps the pre-P3 point
 *  shape byte-for-byte. */
function withInventoryFlag(point: SeriesPoint, row: DerivedRow): SeriesPoint {
  if (row.in_inventory !== undefined && row.in_inventory !== null) {
    point.in_inventory = Boolean(row.in_inventory);
  }
  return point;
}

/** Derived rows -> series points. value = Number(num)/Number(den).
 *
 *  A MISSING NUMERATOR IS A REAL 0, NOT A GAP. buildDerivedSql emits a row for
 *  every rostered backend in every bucket of the window, so a row whose
 *  numerator is absent/NULL/non-finite means "alive, no traffic" and renders as
 *  0 token/s. The rules, in order:
 *    - num null/undefined/non-finite -> emit a point with value 0 (roster zero).
 *    - num exactly 0                 -> emit 0 whatever the denominator: no
 *      tokens means a 0 rate, and an idle bucket has no `series` denominator
 *      rows at all (no requests -> no latency deltas) yet must stay a point.
 *    - num present but negative      -> skip (junk delta; never a negative rate).
 *    - num present, den null/<=0/non-finite -> skip: the rate is genuinely
 *      unknowable (e.g. a `series` denominator with no rows), which is NOT a 0.
 *    - otherwise emit num/den when the quotient is finite.
 *  Emitted points carry the caller-supplied `unit` (the metric's spec unit,
 *  default "token/s"). Order preserved. */
export function derivedPoints(rows: DerivedRow[], group: string, unit: string = "token/s"): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const row of rows) {
    const t = new Date(row.bucket).toISOString();
    const g = row.group ?? group;
    const num = row.num === null || row.num === undefined ? Number.NaN : Number(row.num);
    if (!Number.isFinite(num)) {
      points.push(withInventoryFlag({ t, group: g, value: 0, unit }, row));
      continue;
    }
    if (num < 0) continue;
    if (num === 0) {
      points.push(withInventoryFlag({ t, group: g, value: 0, unit }, row));
      continue;
    }
    const den = row.den === null || row.den === undefined ? Number.NaN : Number(row.den);
    if (!Number.isFinite(den) || den <= 0) continue;
    const value = num / den;
    if (!Number.isFinite(value)) continue;
    points.push(withInventoryFlag({ t, group: g, value, unit }, row));
  }
  return points;
}

// --- Deployment health state (real state, never faked) ---

/** A deployment's derived health status. The Go side derives this from the
 *  raw status code (0 -> healthy, 1 -> prefill, 2/other -> error) and persists
 *  it as text. */
export type DeploymentState = "healthy" | "prefill" | "error";

/** The 4-state activity rule: a bucket with any output-token growth is
 *  `healthy`; with only request/first-token growth (and no output growth) it is
 *  `prefill` (approximate — see the caveat on `deriveActivityStates`); with
 *  all three increases at zero it is `idle`. */
export type ActivityState = "healthy" | "prefill" | "idle";

/** The 4-state wire value carried on `SeriesPoint.state`: the three deployment
 *  health states plus the activity `idle`. */
export type PointState = DeploymentState | ActivityState;

/** A raw `deployment_health` row as returned by pg. All three keys are optional/
 *  nullable — a malformed row (null status or missing keys) is ignored. */
export interface HealthRow {
  model_id: string | null;
  litellm_model_name: string | null;
  status: string | null;
}

/** Severity ordering used to resolve the worst state when a group maps to
 *  several rows. Preserves the pinned relative order error > prefill > healthy
 *  and appends idle at the bottom. */
const STATE_RANK: Record<PointState, number> = { idle: 0, healthy: 1, prefill: 2, error: 3 };

/** Build the deployment-health query. Selects the LATEST health row per
 *  (model_id, litellm_model_name) within the look-back window, which is bound
 *  as `$1` (seconds). `model_id`/`litellm_model_name` are fixed, whitelisted
 *  column names from the documented table contract — never user input. */
export function buildHealthSql(): string {
  return (
    `SELECT DISTINCT ON (model_id, litellm_model_name) model_id, litellm_model_name, status ` +
    `FROM deployment_health ` +
    `WHERE ts >= now() - ($1 * interval '1 second') ` +
    `ORDER BY model_id, litellm_model_name, ts DESC`
  );
}

/** Health rows -> a map keyed by BOTH `model_id` and `litellm_model_name` (each
 *  row contributes to both keys). The value is the group's `DeploymentState`;
 *  when several rows map to the same key the WORST state wins. Contract:
 *  `healthy`/`prefill`/`error` map directly; any OTHER non-null status -> error;
 *  a null/missing status -> the row is ignored (its keys stay absent). */
export function buildStateByGroup(rows: readonly HealthRow[]): Map<string, DeploymentState> {
  const map = new Map<string, DeploymentState>();
  for (const row of rows) {
    const status = row.status;
    let state: DeploymentState;
    if (status === "healthy" || status === "prefill" || status === "error") {
      state = status;
    } else if (status === null || status === undefined) {
      continue; // malformed row — ignore
    } else {
      state = "error"; // contract: other -> error
    }
    for (const key of [row.model_id, row.litellm_model_name]) {
      if (key === null || key === undefined) continue;
      const k = String(key);
      const prev = map.get(k);
      if (!prev || STATE_RANK[state] > STATE_RANK[prev]) map.set(k, state);
    }
  }
  return map;
}

// --- Activity state machine ---

/** The three whitelisted activity-counter sources. Each entry carries a CTE
 *  prefix (n/r/t), a display key (out/req/ttft), and the raw-table read source
 *  (table + optional metric discriminator). These literals are the ONLY source
 *  of table/metric identifiers for the activity query — request input is NEVER
 *  interpolated. The spellings are the scraper SSOT from
 *  apps/scraper/internal/parser/mapping.go:148-212 + store.go:117-155
 *  (histograms stored as base+_sum / base+_count; names never shortened). */
export const ACTIVITY_SOURCES: { key: "out" | "req" | "ttft"; prefix: string; source: DerivedSource }[] = [
  { key: "out", prefix: "n", source: { table: "output_tokens", metric: "litellm_output_tokens_metric_total" } },
  { key: "req", prefix: "r", source: { table: "latency", metric: "litellm_request_total_latency_metric_count" } },
  { key: "ttft", prefix: "t", source: { table: "latency", metric: "litellm_llm_api_time_to_first_token_metric_count" } },
];

/** Build the activity state-machine query. Reads the RAW hypertables
 *  (output_tokens, latency) — no continuous aggregate exists for these
 *  families — and sums the ALREADY-differenced per-scrape `value` column per
 *  time_bucket via the `activitySourceCtes` helper (prefixes n/r/t for
 *  out/req/ttft). The stored column is a per-scrape delta (delta.go differenced
 *  it before insert), so this is a plain SUM(value) — no LAG, no re-differencing,
 *  and NO `HAVING`/`delta > 0` filter: an all-zero bucket MUST survive so it can
 *  classify `idle`.
 *
 *  `tier`/`group` are validated against DERIVED_INTERVAL/GROUPS BEFORE
 *  interpolation; unknown input throws. `$1` is bound to the range seconds,
 *  exactly like buildDerivedSql.
 *
 *  The final SELECT emits `bucket`, the group value under the single stable alias
 *  `grp` (so deriveActivityStates reads one key regardless of the axis), then
 *  `out_inc`, `req_inc`, `ttft_inc`, using FULL OUTER JOINs with COALESCEd keys
 *  and COALESCEd measures.
 *
 *  CRITICAL: this is deliberately NOT the INNER join shape buildDerivedSql uses.
 *  A bucket with req/ttft but no output tokens IS the prefill case and must
 *  survive; a bucket with only output tokens must survive too. An INNER join
 *  would silently drop either half.
 *  "Window w = one display window (e.g. [1m])".
 *  S2 CONFIRMED: the API derives once, the frontend renders only
 * . */
export function buildActivitySql(tier: string, group: string): string {
  if (!GROUPS.includes(group)) throw new Error(`unknown group: ${group}`);
  const interval = DERIVED_INTERVAL[tier];
  if (interval === undefined) throw new Error(`unknown tier: ${tier}`);

  const nCtes = activitySourceCtes("n", ACTIVITY_SOURCES[0].source, group, interval);
  const rCtes = activitySourceCtes("r", ACTIVITY_SOURCES[1].source, group, interval);
  const tCtes = activitySourceCtes("t", ACTIVITY_SOURCES[2].source, group, interval);

  return (
    `WITH ${nCtes}, ${rCtes}, ${tCtes} ` +
    `SELECT COALESCE(n.bucket, r.bucket, t.bucket) AS bucket, ` +
    `COALESCE(n.${group}, r.${group}, t.${group}) AS grp, ` +
    `COALESCE(n.v, 0) AS out_inc, COALESCE(r.v, 0) AS req_inc, COALESCE(t.v, 0) AS ttft_inc ` +
    `FROM nagg n ` +
    `FULL OUTER JOIN ragg r ON r.bucket = n.bucket AND r.${group} = n.${group} ` +
    `FULL OUTER JOIN tagg t ON t.bucket = COALESCE(n.bucket, r.bucket) AND t.${group} = COALESCE(n.${group}, r.${group}) ` +
    `ORDER BY bucket, grp`
  );
}

/** A raw activity row as returned by pg. `bucket` may be a Date (pg timestamptz)
 *  or an ISO string; the three measures may be numeric strings (pg returns
 *  `numeric` as text), null, or other non-finite values — `deriveActivityStates`
 *  collapses them all to zero. */
export type ActivityRow = { bucket: Date | string; grp: string; out_inc: unknown; req_inc: unknown; ttft_inc: unknown };

/** Activity rows -> a map keyed by `${ISO bucket}|${grp}` (matching
 *  SeriesPoint.t + group exactly) to the derived ActivityState.
 *
 *  The 4-state rule, applied verbatim per bucket:
 *    out > 0            -> healthy
 *    req === 0 AND
 *    ttft === 0         -> idle
 *    otherwise          -> prefill
 *
 *  Rows with a null/undefined bucket or group are skipped entirely — a point is
 *  NEVER invented from partial data. Each measure is coerced via Number();
 *  null/undefined/NaN/Infinity/negative all collapse to 0 (a gap must never
 *  fabricate activity). pg returns numerics as strings, hence Number().
 *
 *  Duplicate keys collapse worst-wins via STATE_RANK: only overwrite when
 *  STATE_RANK[next] > STATE_RANK[existing] (idle < healthy < prefill < error).
 *
 *  CAVEAT: ORANGE/prefill is inherently
 *  APPROXIMATE — it under-reports and lags because a request whose first token
 *  has arrived but whose output counter has not yet been scraped also looks
 *  like prefill. The reliable fix is a per-model in-flight gauge
 *  (litellm_model_in_flight), which the scraper does NOT implement, so the
 *  heuristic stays. Additionally, `latency` gained its `metric` column in
 *  migration 006, so legacy latency rows have `metric IS NULL` and will not
 *  match the req/ttft filters (known limitation -> those buckets can read
 *  idle). A ~5-min idle heartbeat means a
 *  genuinely idle deployment still produces rows; NULL value = "scraped,
 *  genuinely idle" while NO ROW = "scrape failed / backend down" — this
 *  function never re-adds missing buckets. */
export function deriveActivityStates(rows: readonly ActivityRow[]): Map<string, ActivityState> {
  const map = new Map<string, ActivityState>();
  const inc = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  for (const row of rows) {
    if (row.bucket === null || row.bucket === undefined) continue;
    if (row.grp === null || row.grp === undefined) continue;
    const key = `${new Date(row.bucket).toISOString()}|${row.grp}`;
    const out = inc(row.out_inc);
    const req = inc(row.req_inc);
    const ttft = inc(row.ttft_inc);
    let state: ActivityState;
    if (out > 0) state = "healthy";
    else if (req === 0 && ttft === 0) state = "idle";
    else state = "prefill";
    const existing = map.get(key);
    if (existing === undefined || STATE_RANK[state] > STATE_RANK[existing]) map.set(key, state);
  }
  return map;
}

/** A raw bridge row: one request-side series label (the cagg `model` /
 *  `api_provider` column value, i.e. what the gateway was *asked* for) paired
 *  with the deployment-side `model_id` it co-occurs with in the raw hypertable.
 *  Both are nullable — a row missing either half carries no mapping information
 *  and is skipped by `buildLabelToModelIds`. */
export interface BridgeRow {
  label: string | null;
  model_id: string | null;
}

/** Build the request-label -> `model_id` bridge query. The continuous
 *  aggregates group by `model` (the requested model) and do NOT carry
 *  `model_id`, while `deployment_health` is keyed by `model_id` — the two label
 *  namespaces never intersect, so the mapping has to be derived, not hardcoded.
 *  Every raw hypertable (`requests`, `spend`, `tokens`, `latency`, `limits`)
 *  stores `model` and `model_id` on the SAME row, so a `DISTINCT` co-occurrence
 *  projection over the requested range yields the mapping. This is the
 *  "join through `model_id`" bridge. Interpolation trust is identical
 *  to `buildSeriesSql`: `metric` and `group` are pre-validated against the
 *  METRICS/GROUPS whitelists by `validateSeriesParams` before this runs, so they
 *  are known-safe identifiers; the look-back window is bound as `$1` (seconds). */
export function buildBridgeSql(metric: string, group: string): string {
  return (
    `SELECT DISTINCT ${group} AS label, model_id FROM ${metric} ` +
    `WHERE model_id IS NOT NULL AND ${group} IS NOT NULL ` +
    `AND ts >= now() - ($1 * interval '1 second')`
  );
}

/** Bridge rows -> `label -> model_id[]`. Rows with a null/undefined label or
 *  `model_id` are skipped (no mapping), values are coerced with `String()`,
 *  duplicate pairs collapse, and first-seen order is preserved. One label may
 *  map to several deployments — that is expected, `attachStates` resolves it. */
export function buildLabelToModelIds(
  rows: readonly BridgeRow[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (row === null || row === undefined) continue;
    const { label, model_id } = row;
    if (label === null || label === undefined) continue;
    if (model_id === null || model_id === undefined) continue;
    const l = String(label);
    const m = String(model_id);
    const seen = map.get(l);
    if (seen === undefined) map.set(l, [m]);
    else if (!seen.includes(m)) seen.push(m);
  }
  return map;
}

/** Attach a state to each series point, in place, and return them. Resolution
 *  order per point (worst-wins within each authority, via STATE_RANK):
 *
 *  (a) DEPLOYMENT health: the point's `group` is a request-side label, looked up
 *  directly first (legacy: the label may already BE a `model_id` /
 *  `litellm_model_name`) and then through every `model_id` the bridge maps it to.
 *  The WORST deployment state across candidates that exist in `stateByGroup`
 *  wins (AMBIGUITY RULE: one label served by several deployments with differing
 *  states reports the worst — exactly how `buildStateByGroup` collapses several
 *  deployments onto one key).
 *  (b) ERROR IS ABSOLUTE `deployment_health` is the error
 *  authority, so a resolved `error` is assigned and the point is done — no
 *  derived activity reading (idle/healthy/prefill) may ever mask a real error.
 *  (c) ACTIVITY: when `activityByBucketGroup` is provided and holds a key for
 *  `${t}|${group}` (the same key `deriveActivityStates` builds), that derived
 *  ActivityState (healthy/prefill/idle) is assigned. The API derives it once and
 *  the frontend renders only — it never recomputes. A
 *  non-error deployment state is pre-empted by the per-bucket activity reading.
 *  (d) FALLBACK to the resolved deployment state (step a) when no activity
 *  reading exists for the point — this preserves the legacy 3-argument behavior.
 *  (e) When nothing resolves, `state` is left undefined: it is never fabricated.
 *
 *  The optional fourth parameter defaults to "absent": a 3-argument call, or a
 *  4-argument call with an empty map, is byte-for-byte the legacy behavior
 *  (deployment state only, else undefined). */
export function attachStates(
  points: SeriesPoint[],
  stateByGroup: Map<string, DeploymentState>,
  labelToModelIds: Map<string, string[]>,
  activityByBucketGroup?: Map<string, ActivityState>
): SeriesPoint[] {
  for (const p of points) {
    // (a) deployment-health candidates: direct group + every bridged model_id,
    //  worst-wins via STATE_RANK.
    const candidates: string[] = [p.group, ...(labelToModelIds.get(p.group) ?? [])];
    let h: DeploymentState | undefined;
    for (const key of candidates) {
      const s = stateByGroup.get(key);
      if (s === undefined) continue;
      if (h === undefined || STATE_RANK[s] > STATE_RANK[h]) h = s;
    }
    // (b) error is absolute: it can never be masked by a derived activity state.
    if (h === "error") {
      p.state = "error";
      continue;
    }
    // (c) per-bucket derived activity state, keyed `${t}|${group}` — pre-empts a
    //  non-error deployment state.
    if (activityByBucketGroup !== undefined) {
      const act = activityByBucketGroup.get(`${p.t}|${p.group}`);
      if (act !== undefined) {
        p.state = act;
        continue;
      }
    }
    // (d) fall back to the resolved deployment state (legacy behavior).
    if (h !== undefined) {
      p.state = h;
      continue;
    }
    // (e) nothing resolves -> state stays undefined; never fabricated.
  }
  return points;
}

/** rows -> finished series points. Applies the NULL->0 boundary rule: a
 *  storage `NULL` (idle) becomes `0`; a numeric value passes through. Every row
 *  maps to one point (order preserved). `toPoints` never sets `state` — the
 *  handler derives state from the `deployment_health` table and assigns it
 *  after normalisation (absent -> undefined -> the frontend renders neutral). */
export function toPoints(rows: readonly PointRow[]): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const row of rows) {
    let value: number;
    if (row.value === null || row.value === undefined) {
      value = 0; // storage NULL (idle) -> 0 at the boundary
    } else {
      value = Number(row.value);
    }
    points.push({
      t: new Date(row.bucket).toISOString(),
      group: row.group,
      value,
    });
  }
  return points;
}

// ===========================================================================
// Scrape health (D5): a dead scrape must never masquerade as an idle fleet.
// The scraper writes `instance_health` once per scrape; if no health row (up or
// not) has landed recently then every value in the window is stale, and a fleet
// that looks uniformly idle is really a fleet nobody is looking at.
// `last_seen_ts` is the LIVENESS signal (newest health row, up or not);
// `last_up_ts` is diagnostic / last-success only. So the API probes the probe
// and, when it is down, stamps the response as known-nothing instead of serving
// confident garbage.
// ===========================================================================

/** How stale the newest successful scrape may be before the fleet is declared
 *  DOWN: 5 x the scraper's 15s scrape interval, so one missed scrape (slow
 *  response, transient 500) does not stamp the fleet, but five in a row does. */
export const DEFAULT_SCRAPE_DOWN_AFTER_MS = 75000;

/** Resolve the threshold from `SCRAPE_DOWN_AFTER_MS`: unset, empty, non-numeric
 *  or < 1 all fall back to DEFAULT_SCRAPE_DOWN_AFTER_MS; a valid value is floored
 *  to an integer (`resolveTopN` shape, `env` injected so it is testable). */
export function resolveScrapeDownAfterMs(env?: NodeJS.ProcessEnv): number {
  const raw = env?.SCRAPE_DOWN_AFTER_MS;
  if (raw === undefined) return DEFAULT_SCRAPE_DOWN_AFTER_MS;
  const trimmed = String(raw).trim();
  if (trimmed === "") return DEFAULT_SCRAPE_DOWN_AFTER_MS;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SCRAPE_DOWN_AFTER_MS;
  return Math.floor(parsed);
}

/** The threshold, resolved ONCE at module load (see `TOP_N`): env is fixed for
 *  the process lifetime and a request must never be able to steer it. */
export const SCRAPE_DOWN_AFTER_MS = resolveScrapeDownAfterMs(process.env);

/** The single row `buildScrapeHealthSql` emits. Both columns are NULL when the
 *  window holds no rows: an aggregate query always returns exactly one row, so
 *  "no rows" arrives as "one row of nulls" = no health row lately (scraper
 *  down). `last_seen_ts` is the LIVENESS signal — the newest health row of any
 *  kind, regardless of `up`. `last_up_ts` is diagnostic / last-success only:
 *  it marks the newest row where `up = true` and feeds the
 *  X-Scrape-Last-Success header; it is never used for the down/up rule. */
export type ScrapeHealthRow = { last_up_ts?: Date | string | null; last_seen_ts?: Date | string | null };

/** The fleet-wide scrape-health probe. Reads `instance_health` ONLY and binds the
 *  threshold as `$1` in milliseconds — nothing is interpolated, not even a
 *  whitelisted identifier. It fetches MAXIMA and nothing else: the up/down RULE
 *  lives in `scrapeStatus`, so the rule is probeable without a database.
 *  `last_seen_ts` (the MAX ts, up or not) is the LIVENESS signal: the scraper is
 *  down when even a single health row is missing from the window. `last_up_ts`
 *  (the MAX ts filtered to up=true) is diagnostic / last-success only — it
 *  feeds the X-Scrape-Last-Success header and is never used for the down/up
 *  determination. */
export function buildScrapeHealthSql(): string {
  return (
    `SELECT max(ts) FILTER (WHERE up) AS last_up_ts, max(ts) AS last_seen_ts ` +
    `FROM instance_health WHERE ts >= now() - ($1 * interval '1 millisecond')`
  );
}

/** THE scrape liveness rule — it lives here and nowhere else. `nowMs`/
 *  `thresholdMs` are epoch-milliseconds so the rule is pure; `lastSeenTs` is the
 *  newest health-row timestamp (whatever pg handed back: `timestamptz` -> Date,
 *  or text), regardless of `up`. Liveness means "the scraper wrote ANY health
 *  row recently" — not "a target succeeded recently". A null/invalid timestamp
 *  -> DOWN with neither last-scrape nor staleness: we cannot say how stale we
 *  are, only that there is no recent row. A future-dated timestamp clamps to 0
 *  staleness. */
export function scrapeStatus(
  lastSeenTs: Date | string | null,
  nowMs: number,
  thresholdMs: number
): { up: boolean; lastScrapeTs: string | null; stalenessMs: number | null } {
  const ts =
    lastSeenTs instanceof Date
      ? lastSeenTs.getTime()
      : lastSeenTs === null || lastSeenTs === undefined
        ? NaN
        : Date.parse(String(lastSeenTs));
  if (!Number.isFinite(ts)) return { up: false, lastScrapeTs: null, stalenessMs: null };
  const age = nowMs - ts;
  return {
    up: age <= thresholdMs,
    lastScrapeTs: new Date(ts).toISOString(),
    stalenessMs: Math.max(0, age),
  };
}

/** Stamp every point as a known-nothing zero because the scrape is down.
 *  `state: "error"` is deliberate: it is the EXISTING wire state the UI already
 *  renders as the blue light — no new state name is invented, so the current web
 *  shows "something is wrong" with no frontend change. `synthetic: true` marks
 *  the zero as not-a-measurement, so ranking/averaging/top-N must skip it.
 *  Returns a new array of new objects; the input is never mutated. */
export function stampScrapeDown(points: readonly SeriesPoint[]): SeriesPoint[] {
  return points.map((p) => ({ ...p, value: 0, state: "error", synthetic: true }));
}

// ===========================================================================
// Top-N cap (D1): the API-side group cap is a knob, and inventory is exempt
// ===========================================================================

/** The API-side top-N group cap. This is NOT the web's cap — apps/web keeps its
 *  own DEFAULT_TOP_N = 6 until Phase 3; the two knobs are independent. */
export const DEFAULT_TOP_N = 20;

/** Resolve the cap from `API_TOP_N`: unset, empty, non-numeric or < 1 all fall
 *  back to DEFAULT_TOP_N; a valid value is floored to an integer. `env` is a
 *  parameter so the rule is testable without mutating process.env. */
export function resolveTopN(env?: NodeJS.ProcessEnv): number {
  const raw = env?.API_TOP_N;
  if (raw === undefined) return DEFAULT_TOP_N;
  const trimmed = String(raw).trim();
  if (trimmed === "") return DEFAULT_TOP_N;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TOP_N;
  return Math.floor(parsed);
}

/** The cap, resolved ONCE at module load. The handler must not re-read env per
 *  request: env is fixed for the process lifetime, and a request must never be
 *  able to steer the cap. */
export const TOP_N = resolveTopN(process.env);

/** Cap a series at `topN` groups, EXEMPTING every group in `exemptGroups`
 *  (D1: inventory rows are never truncated by the cap). The non-exempt groups are
 *  ranked by descending total value over the window, ties broken by group name
 *  ascending so the ranking is deterministic, and the first `topN` of those are
 *  kept; the output preserves the original point order. A non-finite or
 *  non-positive `topN` falls back to DEFAULT_TOP_N rather than emptying the
 *  series.
 *
 *  `unassigned` is NEVER dropped by truncation it is exempt UNCONDITIONALLY,
 *  unioned into the exempt set inside this function rather than trusted to the
 *  call site, so a failed inventory query cannot make it truncatable. Whether it
 *  is *shown* at all is a web build-time flag, never an API truncation decision.
 *
 *  Synthetic points (see `SeriesPoint.synthetic`) are unknowns, not measurements:
 *  they never contribute to a group's ranking total and are never dropped by the
 *  cap. Non-synthetic behavior is unchanged. */
export function applyTopN(
  points: readonly SeriesPoint[],
  topN: number,
  exemptGroups?: ReadonlySet<string>
): SeriesPoint[] {
  const cap = Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : DEFAULT_TOP_N;
  const exempt = exemptGroups ?? new Set<string>();
  const totals = new Map<string, number>();
  for (const p of points) {
    if (p.synthetic) continue; // not a measurement -> contributes nothing
    const v = Number.isFinite(p.value) ? p.value : 0;
    totals.set(p.group, (totals.get(p.group) ?? 0) + v);
  }
  const ranked = [...totals.keys()]
    .filter((g) => !exempt.has(g))
    .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b));
  const keep = new Set<string>(exempt);
  keep.add(UNASSIGNED_GROUP); // unconditionally exempt, whatever the caller passed
  for (const g of ranked.slice(0, cap)) keep.add(g);
  return points.filter((p) => keep.has(p.group) || p.synthetic === true);
}

// ===========================================================================
// KPI endpoint (GET /api/kpis?range= -> the six
// fixed fields { rps, error_rate, spend_usd, tokens, p95_ms, healthy_deployments}).
// Null convention: unknown/missing -> null, scraped-zero -> 0.
// A KPI with NO data source is emitted as the key present with value `null`
// plus a console.warn — never omitted, never a fabricated 0 (the same precedent
// the "errors" metric sets on /api/series).
// ===========================================================================

/** The cagg families a KPI range-total may read. Fixed whitelist — the ONLY
 *  source of table names for `buildKpiTotalSql`; request input is never
 *  interpolated into SQL. "tokens" is deliberately ABSENT: the merged `tokens`
 *  hypertable and its `1m/5m/1h` continuous aggregates were dropped, so
 *  no cagg path may name a tokens table; the tokens KPI reads the raw
 *  `total_tokens` family instead (see buildKpiTotalRawSql / TOKENS_KPI_TABLE). */
const KPI_TOTAL_FAMILIES: readonly string[] = ["requests", "spend"];

/** The tokens KPI's single source of truth: the dedicated `total_tokens` raw
 *  hypertable. RAW TIER ONLY — no continuous aggregate exists for any
 *  per-family tokens table, so no tier suffix is ever appended here. */
const TOKENS_KPI_TABLE = "total_tokens";

/** The whitelisted cagg bucket tiers (`TIER_MAP` values, which are exactly the
 *  `DERIVED_INTERVAL` keys: "1m" | "5m" | "1h"). Interpolated into table names
 *  only after validation against this list. */
const CAGG_TIERS: readonly string[] = Object.values(TIER_MAP);

/** Discriminated result of `validateKpiParams`. The `ok: true` branch carries
 *  exactly { ok, range }. */
export type KpiValidation = { ok: true; range: string } | { ok: false; error: string };

/** Validate the `/api/kpis` query params: `range` must be a `RANGE_SECONDS`
 *  key. The error strings are the exact ones `validateSeriesParams` uses, so
 *  every endpoint reports a bad range identically. */
export function validateKpiParams(query: { range?: string }): KpiValidation {
  const range = query.range;
  if (typeof range !== "string" || range.length === 0) {
    return { ok: false, error: "missing or invalid range" };
  }
  if (!Object.prototype.hasOwnProperty.call(RANGE_SECONDS, range)) {
    return { ok: false, error: `unknown range: ${range}` };
  }
  return { ok: true, range };
}

/** Range-total query for one KPI counter family on the CONTINUOUS-AGGREGATE
 *  path. Each cagg row stores the PER-INTERVAL DELTA (verified against the live
 *  continuous aggregates), so SUM(sum_value) over the window IS the window
 *  total and a single-unit family carries no double-count. `family` and `tier`
 *  are whitelisted identifiers (checked against KPI_TOTAL_FAMILIES / CAGG_TIERS
 *  BEFORE any interpolation, same discipline as buildSeriesSql); the look-back
 *  window is bound as `$1` (seconds). */
export function buildKpiTotalSql(family: string, tier: string): string {
  if (!KPI_TOTAL_FAMILIES.includes(family)) {
    throw new Error(`unknown family: ${family}`);
  }
  if (!CAGG_TIERS.includes(tier)) {
    throw new Error(`unknown tier: ${tier}`);
  }
  return (
    `SELECT SUM(sum_value) AS total FROM ${family}_${tier} ` +
    `WHERE bucket >= now() - ($1 * interval '1 second')`
  );
}

/** Range-total query on the RAW-TIER path, for a KPI family whose continuous
 *  aggregates no longer exist. Mirrors `buildRawSeriesSql`: it reads the raw
 *  hypertable's `value` column (NOT the cagg `sum_value`) and bounds the
 *  look-back on the raw time column `ts`, with the window bound as `$1`
 *  (seconds) — the same binding convention as every other query here.
 *  `table` comes from a fixed in-module constant (TOKENS_KPI_TABLE), never from
 *  request input, so nothing user-controlled is interpolated. */
export function buildKpiTotalRawSql(table: string): string {
  return (
    `SELECT SUM(value) AS total FROM ${table} ` +
    `WHERE ts >= now() - ($1 * interval '1 second')`
  );
}

/** One row of a `buildKpiTotalSql` result. pg parses numeric/`double precision`
 *  as text, so `total` arrives as a string, a number, or `null` (empty window). */
export interface KpiTotalRow {
  total?: unknown;
}

/** The single range total, or `null` when it is UNKNOWN: no row, a null/
 *  undefined total, or a non-finite number all mean "no data" —
 *  never a fake 0. */
export function kpiTotal(rows: readonly KpiTotalRow[]): number | null {
  if (rows.length === 0) return null;
  const raw = rows[0]?.total;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Health rows -> the number of DISTINCT `model_id`s whose resolved state is
 *  `healthy`. Rows whose `model_id` is null/undefined are skipped (they identify
 *  no deployment). Several rows for one model_id collapse WORST-WINS through the
 *  existing STATE_RANK order (error > prefill > healthy), so a model_id with any
 *  error or prefill row is not counted as healthy. A null/missing `status` makes
 *  the row malformed and it is ignored (same rule as buildStateByGroup); any
 *  other non-null status is treated as `error`. Returns `null` when no usable
 *  row survived — unknown, never a fake 0. */
export function countHealthyDeployments(rows: readonly HealthRow[]): number | null {
  const stateByModelId = new Map<string, DeploymentState>();
  for (const row of rows) {
    const modelId = row.model_id;
    if (modelId === null || modelId === undefined) continue;
    const status = row.status;
    let state: DeploymentState;
    if (status === "healthy" || status === "prefill" || status === "error") {
      state = status;
    } else if (status === null || status === undefined) {
      continue; // malformed row — ignore
    } else {
      state = "error"; // contract: other -> error
    }
    const key = String(modelId);
    const prev = stateByModelId.get(key);
    if (!prev || STATE_RANK[state] > STATE_RANK[prev]) stateByModelId.set(key, state);
  }
  if (stateByModelId.size === 0) return null;
  let count = 0;
  for (const state of stateByModelId.values()) {
    if (state === "healthy") count += 1;
  }
  return count;
}

// ===========================================================================
// Request handler
// ===========================================================================

interface HandlerDeps {
  query: QueryFn;
}

/** Write a JSON body with the given status. `extraHeaders` is merged into the
 *  fixed CORS/JSON headers (it never replaces them) so an endpoint can publish
 *  side-channel metadata without changing the body shape. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

// ===========================================================================
// Breakdown endpoint (
// GET /api/breakdown?metric=spend&range=24h -> [{ label, value }]). The
// frontend `Metric` union (apps/web/src/lib/types.ts) is the cagg-backed set;
// the derived /api/series metrics have no continuous aggregate, so they are not
// breakdown-capable here.
// ===========================================================================

/** The cagg-backed metrics a breakdown may aggregate (the frontend `Metric`
 *  union). Fixed whitelist — the ONLY source of table names for
 *  `buildBreakdownSql`; request input is never interpolated into SQL. */
const BREAKDOWN_METRICS: readonly string[] = ["requests", "errors", "spend", "tokens", "latency"];

/** Discriminated result of `validateBreakdownParams`. The `ok: true` branch
 *  carries exactly { ok, metric, range, group }; `group` defaults to "model"
 *  (a documented extension — the frontend never sends it). */
export type BreakdownValidation =
  | { ok: true; metric: string; range: string; group: string }
  | { ok: false; error: string };

/** Validate the `/api/breakdown` query params. Checks in the fixed order
 *  metric, range, group, naming the offending parameter, with the same error
 *  strings as `validateSeriesParams`. Only cagg-backed metrics are accepted: a
 *  derived metric (decode_tps, input_tps, decode_tps_implied) is reported as
 *  an unknown metric because it has no continuous aggregate to aggregate. */
export function validateBreakdownParams(query: {
  metric?: string;
  range?: string;
  group?: string;
}): BreakdownValidation {
  const metric = query.metric;
  if (typeof metric !== "string" || metric.length === 0) {
    return { ok: false, error: "missing or invalid metric" };
  }
  if (!BREAKDOWN_METRICS.includes(metric)) {
    return { ok: false, error: `unknown metric: ${metric}` };
  }

  const range = query.range;
  if (typeof range !== "string" || range.length === 0) {
    return { ok: false, error: "missing or invalid range" };
  }
  if (!Object.prototype.hasOwnProperty.call(RANGE_SECONDS, range)) {
    return { ok: false, error: `unknown range: ${range}` };
  }

  const group = query.group ?? "model";
  if (!GROUPS.includes(group)) {
    return { ok: false, error: `unknown group: ${group}` };
  }

  return { ok: true, metric, range, group };
}

/** Build the parameterized breakdown query. `metric`, `tier` and `group` are
 *  whitelisted identifiers, checked against BREAKDOWN_METRICS / CAGG_TIERS /
 *  GROUPS BEFORE any interpolation (the same discipline as buildSeriesSql and
 *  buildKpiTotalSql). The aggregate comes from the existing `valueColumn()`:
 *  avg_value -> AVG(avg_value) for the latency gauge, sum_value -> SUM(sum_value)
 *  for the counters. The look-back window is bound as `$1` (seconds).
 *  EXCEPTION: `tokens` is RAW-TIER ONLY (its continuous aggregates were dropped)
 *  and is served from the raw `total_tokens` hypertable via TOKENS_KPI_TABLE,
 *  mirroring buildKpiTotalRawSql; `tier` is unused on that path. */
export function buildBreakdownSql(metric: string, tier: string, group: string): string {
  if (!BREAKDOWN_METRICS.includes(metric)) {
    throw new Error(`unknown metric: ${metric}`);
  }
  const valueCol = valueColumn(metric);
  if (valueCol === undefined) {
    throw new Error(`metric has no value column: ${metric}`);
  }
  if (!CAGG_TIERS.includes(tier)) {
    throw new Error(`unknown tier: ${tier}`);
  }
  if (!GROUPS.includes(group)) {
    throw new Error(`unknown group: ${group}`);
  }
  // `tokens` is RAW-TIER ONLY: the merged `tokens` hypertable and its
  // `1m/5m/1h` continuous aggregates were dropped, so no tokens cagg may be
  // named here. Mirrors buildKpiTotalRawSql — the raw `total_tokens`
  // hypertable's `value` column (NOT the cagg `sum_value`), bounded on the raw
  // time column `ts`, with the window bound as `$1` (seconds) like every other
  // query here. `tier` is intentionally unused on this path; `group` is already
  // whitelisted against GROUPS above, so nothing user-controlled is interpolated.
  if (metric === "tokens") {
    return (
      `SELECT ${group} AS label, SUM(value) AS value FROM ${TOKENS_KPI_TABLE} ` +
      `WHERE ts >= now() - ($1 * interval '1 second') ` +
      `GROUP BY ${group} ORDER BY value DESC`
    );
  }
  const agg = valueCol === "avg_value" ? "AVG(avg_value)" : "SUM(sum_value)";
  return (
    `SELECT ${group} AS label, ${agg} AS value FROM ${metric}_${tier} ` +
    `WHERE bucket >= now() - ($1 * interval '1 second') ` +
    `GROUP BY ${group} ORDER BY value DESC`
  );
}

/** One row of a `buildBreakdownSql` result: the group column aliased to `label`
 *  and the aggregate aliased to `value`, both arriving as pg text (or null). */
export interface BreakdownRow {
  label?: unknown;
  value?: unknown;
}

/** A finished breakdown entry — matches `Breakdown` in
 *  apps/web/src/lib/types.ts exactly: { label, value }. */
export interface BreakdownItem {
  label: string;
  value: number;
}

/** Breakdown rows -> `[{ label, value }]`. A null/undefined label becomes
 *  "(unknown)" (the convention the series handler already uses for a null
 *  group); a storage NULL aggregate becomes 0, as does a
 *  non-finite value. Sorted by value descending with ties broken by label
 *  ascending, so the payload is deterministic. Every row is emitted — the
 *  contract sets no row limit. */
export function toBreakdown(rows: readonly BreakdownRow[]): BreakdownItem[] {
  const items: BreakdownItem[] = rows.map((row) => {
    const rawLabel = row.label;
    const label = rawLabel === null || rawLabel === undefined ? "(unknown)" : String(rawLabel);
    let value: number;
    if (row.value === null || row.value === undefined) {
      value = 0; // storage NULL (idle) -> 0 at the boundary
    } else {
      value = Number(row.value);
      if (!Number.isFinite(value)) value = 0;
    }
    return { label, value };
  });
  items.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
  return items;
}

/** GET /api/kpis?range= -> the six contract fields, ALL keys always present.
 *
 *  `error_rate` and `p95_ms` have NO data source in this database (verified
 *  read-only against the live aggregates): the `requests` cagg has no `metric`
 *  discriminator and its unit is always 'count', so the failed-request counters
 *  (litellm_proxy_failed_requests_metric_total) are collapsed into it and an
 *  error rate is not computable (the `counters` table is empty); and the Go
 *  parser drops histogram buckets and summary quantiles — only _sum and _count
 *  are stored, so a mean is derivable but a true p95 is NOT. Substituting the
 *  mean would be fabrication. Both are therefore emitted as literal `null` with
 *  a warning, exactly the precedent the "errors" metric sets on /api/series.
 *
 *  The three range totals and the deployment-health query (the existing
 *  buildHealthSql — never a second health query) run together, each individually
 *  failure-tolerant: a sub-query failure warns and nulls ONLY its own field, it
 *  never turns the response into a 500. */
function handleKpis(query: QueryFn, params: URLSearchParams, res: ServerResponse): void {
  const validation = validateKpiParams({ range: params.get("range") ?? undefined });
  if (!validation.ok) {
    sendJson(res, 400, { error: validation.error });
    return;
  }

  const range = validation.range;
  const tier = tierForRange(range);
  const seconds = RANGE_SECONDS[range];
  if (tier === undefined || seconds === undefined) {
    // Unreachable once validation passed; guarded defensively.
    sendJson(res, 500, { error: "internal error: unresolved range mapping" });
    return;
  }

  console.warn("error_rate has no DB backing; emitting null");
  console.warn("p95_ms has no DB backing; emitting null");

  const totalQuery = (family: "requests" | "spend", label: string) =>
    query(buildKpiTotalSql(family, tier), [seconds]).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`kpi ${label} total query failed (emitting null):`, message);
      return { rows: [] as KpiTotalRow[] };
    });

  // The tokens KPI has no continuous aggregate any more: it reads the raw
  // `total_tokens` family, bounded by the SAME requested-range window.
  const tokensTotalQuery = query(buildKpiTotalRawSql(TOKENS_KPI_TABLE), [seconds]).catch(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`kpi tokens total query failed (emitting null):`, message);
      return { rows: [] as KpiTotalRow[] };
    }
  );

  Promise.all([
    totalQuery("requests", "requests"),
    totalQuery("spend", "spend"),
    tokensTotalQuery,
    query(buildHealthSql(), [seconds]).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("deployment_health query failed (emitting null healthy_deployments):", message);
      return { rows: [] as HealthRow[] };
    }),
  ])
    .then(([requests, spend, tokens, health]) => {
      const requestsTotal = kpiTotal(requests.rows as KpiTotalRow[]);
      const rps = requestsTotal === null ? null : requestsTotal / seconds;
      sendJson(res, 200, {
        rps: rps === null || !Number.isFinite(rps) ? null : rps,
        error_rate: null,
        spend_usd: kpiTotal(spend.rows as KpiTotalRow[]),
        tokens: kpiTotal(tokens.rows as KpiTotalRow[]),
        p95_ms: null,
        healthy_deployments: countHealthyDeployments(health.rows as HealthRow[]),
      });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("kpis query failed:", message);
      sendJson(res, 500, { error: "internal error" });
    });
}

/** GET /api/breakdown?metric=&range=&group= -> [{ label, value }]. The "errors"
 *  metric has no DB backing: it validates, then short-circuits to an empty array
 *  with a warning and NEVER queries — the exact /api/series precedent. A failure
 *  of the single aggregate query is a 500: unlike /api/kpis there is no
 *  per-field fallback, the whole payload IS that one query. */
function handleBreakdown(query: QueryFn, params: URLSearchParams, res: ServerResponse): void {
  const validation = validateBreakdownParams({
    metric: params.get("metric") ?? undefined,
    range: params.get("range") ?? undefined,
    group: params.get("group") ?? undefined,
  });
  if (!validation.ok) {
    sendJson(res, 400, { error: validation.error });
    return;
  }

  const { metric, range, group } = validation;

  // "errors" has no DB backing: validate, then short-circuit to an empty
  // breakdown with a warning. NEVER query, NEVER fabricate values.
  if (metric === "errors") {
    console.warn("errors metric has no DB backing; returning empty breakdown");
    sendJson(res, 200, []);
    return;
  }

  const tier = tierForRange(range);
  const seconds = RANGE_SECONDS[range];
  if (tier === undefined || seconds === undefined) {
    // Unreachable once validation passed; guarded defensively.
    sendJson(res, 500, { error: "internal error: unresolved range mapping" });
    return;
  }

  query(buildBreakdownSql(metric, tier, group), [seconds])
    .then((result) => sendJson(res, 200, toBreakdown(result.rows as BreakdownRow[])))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("breakdown query failed:", message);
      sendJson(res, 500, { error: "internal error" });
    });
}

/** Build the single `node:http` request handler. `createServer(handler)` yields
 *  a ready server. GET /api/series, /api/kpis and /api/breakdown are
 *  implemented; every other request is a 404. */
export function createRequestHandler(deps: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { query } = deps;

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method !== "GET") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // Endpoint dispatch. /api/series keeps its exact existing behavior below
    // (same validation, same four queries); /api/kpis and /api/breakdown are
    // their own branches; anything else is the same 404 shape as before.
    if (url.pathname === "/api/kpis") {
      handleKpis(query, url.searchParams, res);
      return;
    }
    if (url.pathname === "/api/breakdown") {
      handleBreakdown(query, url.searchParams, res);
      return;
    }
    if (url.pathname !== "/api/series") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    const params = url.searchParams;
    const validation = validateSeriesParams({
      metric: params.get("metric") ?? undefined,
      range: params.get("range") ?? undefined,
      group: params.get("group") ?? undefined,
    });

    if (!validation.ok) {
      sendJson(res, 400, { error: validation.error });
      return;
    }

    const { metric, range, group } = validation;

    // "errors" has no DB backing: validate, then short-circuit to an empty
    // series with a warning. NEVER query, NEVER fabricate values.
    if (metric === "errors") {
      console.warn("errors metric has no DB backing; returning empty series");
      sendJson(res, 200, []);
      return;
    }

    const tier = tierForRange(range);
    const seconds = RANGE_SECONDS[range];
    if (tier === undefined || seconds === undefined) {
      // Unreachable once validation passed; guarded defensively.
      sendJson(res, 500, { error: "internal error: unresolved range mapping" });
      return;
    }

    const derived = isDerivedMetric(metric);
    // FIX 3: the requests_<tier> cagg has NO model_id column, so a non-derived
    // metric grouped by model_id must read the RAW hypertable (bucketed by the
    // tier interval) instead of the cagg — otherwise the value query 500s.
    const useRaw = !derived && group === "model_id";
    // Derived metrics read the raw hypertables (no cagg exists for them);
    // everything else reads its continuous aggregate. Both bind $1 = seconds.
    const sql = derived
      ? buildDerivedSql(metric, tier, group)
      : useRaw
        ? buildRawSeriesSql(metric, tier, group)
        : buildSeriesSql(metric, tier, group);
    const healthSql = buildHealthSql();
    // The activity-increments query (out/req/ttft) runs for BOTH the request-side
    // cagg metrics and the derived metrics — the per-model_id axis the derived
    // series group by IS the activity axis. It is failure-tolerant on the same terms as health/bridge: a
    // failure degrades to an empty activity map (no derived state) and the value
    // series is STILL served — only a failure of the VALUE query yields a 500.
    const activitySql = buildActivitySql(tier, group);
    // The inventory group set — the groups the top-N cap must never truncate
    // (D1). "" for an axis with no inventory axis (`api_provider`), in which case
    // the round-trip is skipped and the exempt set is empty.
    const inventoryGroupsSql = buildInventoryGroupsSql(group);
    // The scrape-health probe (D5): one aggregate row over `instance_health`,
    // bound to the staleness threshold in ms. Same failure tolerance as the other
    // side queries — if it fails the scrape state is UNKNOWN and nothing is stamped.
    const scrapeHealthSql = buildScrapeHealthSql();
    // The label -> model_id bridge only makes sense for the request-side cagg
    // metrics, whose `model`/`api_provider` labels are not model_ids. Derived
    // metrics are grouped by model_id directly, so the health query's model_id
    // key already matches the series group — no bridge is needed, and querying
    // `FROM <derived-metric>` would hit a non-existent table (a guaranteed-
    // failing round-trip). For derived we resolve state from the direct
    // model_id lookup only, so bridgeSql is null and the bridge slot resolves
    // to an empty placeholder (downstream buildLabelToModelIds/attachStates
    // are unchanged). The raw model_id path (FIX 3) is likewise grouped by
    // model_id directly, so it too skips the bridge.
    const bridgeSql = (derived || useRaw) ? null : buildBridgeSql(metric, group);
    // Six queries run together: the value query, the deployment-health query,
    // (for non-derived metrics) the label -> model_id bridge query, the activity
    // increments, the inventory group set, and the scrape-health probe. All five
    // side queries are failure-tolerant on the same terms: if a table is
    // missing/empty or errors, we fall back to "no state" / "no exemption" /
    // "scrape unknown" and STILL serve the value series. Only a failure of the
    // VALUE query yields a 500.
    Promise.all([
      query(sql, [seconds]),
      query(healthSql, [seconds]).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("deployment_health query failed (serving without state):", message);
        return { rows: [] as HealthRow[] };
      }),
      bridgeSql === null
        ? Promise.resolve({ rows: [] as BridgeRow[] })
        : query(bridgeSql, [seconds]).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.warn("model_id bridge query failed (serving without bridged state):", message);
            return { rows: [] as BridgeRow[] };
          }),
      // The fourth, failure-tolerant activity query. A failure (missing table,
      // scrape gap, ...) degrades to an empty activity map -> no derived
      // activity state, and the value series is STILL served. It must never turn
      // a 200 into a 500 (the API derives once; the frontend never
      // fabricates state).
      query(activitySql, [seconds]).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("activity query failed (serving without derived activity state):", message);
        return { rows: [] as ActivityRow[] };
      }),
      // The fifth, failure-tolerant query: the inventory group set the top-N cap
      // exempts. A failure degrades to an EMPTY exempt set (the cap then applies
      // to every group) and the value series is STILL served — it must never turn
      // a 200 into a 500. No inventory axis for this group -> no round-trip.
      inventoryGroupsSql === ""
        ? Promise.resolve({ rows: [] as InventoryGroupRow[] })
        : query(inventoryGroupsSql, []).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.warn("inventory group query failed (serving without the top-N exemption):", message);
            return { rows: [] as InventoryGroupRow[] };
          }),
      // The sixth, failure-tolerant query: the scrape-health probe (D5). On
      // FAILURE the scrape state is UNKNOWN — we do not stamp, we keep serving the
      // values we did get, and we warn. A probe that cannot answer must never turn
      // a 200 into a 500, and never stamp a fleet it never observed.
      query(scrapeHealthSql, [SCRAPE_DOWN_AFTER_MS]).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("scrape-health query failed (serving without scrape-down stamping):", message);
        return { rows: [] as ScrapeHealthRow[] };
      }),
    ])
      .then(([values, health, bridge, activity, inventory, scrape]) => {
        // Normalize raw rows to the group column (either `model`,
        // `api_provider`, or `model_id` depending on the requested grouping).
        let points: SeriesPoint[];
        if (derived) {
          const derivedRows: DerivedRow[] = values.rows.map((row) => ({
            bucket: row.bucket,
            group: row[group] === null || row[group] === undefined ? "(unknown)" : String(row[group]),
            num: row.num,
            den: row.den,
            in_inventory: row.in_inventory,
          }));
          points = derivedPoints(derivedRows, group, DERIVED[metric].unit);
        } else {
          const pointRows: PointRow[] = values.rows.map((row) => ({
            bucket: row.bucket,
            group: row[group] === null || row[group] === undefined ? "(unknown)" : String(row[group]),
            value: row.value,
          }));
          points = toPoints(pointRows);
        }
        const stateByGroup = buildStateByGroup(health.rows as HealthRow[]);
        // Request-side labels never appear in deployment_health, so resolve
        // state through the model_id bridge (direct label lookup still wins
        // when the label already is a model_id / litellm_model_name). The
        // per-bucket activity state (derived once from the out/req/ttft
        // increments) takes precedence over a NON-error deployment state
        //
        // but can never override an error — error is absolute.
        const activityByBucketGroup = deriveActivityStates(activity.rows as ActivityRow[]);
        attachStates(
          points,
          stateByGroup,
          buildLabelToModelIds(bridge.rows as BridgeRow[]),
          activityByBucketGroup
        );
        // When grouping by model_id, surface the LiteLLM deployment label
        // (litellm_model_name) so the UI can render "model_id · litellm_model_name".
        // Reuses the health rows already in scope — no new query. Only points whose
        // group matches a known model_id are stamped; the rest stay untouched.
        if (group === "model_id") {
          const nameByModelId = new Map<string, string>();
          for (const row of health.rows as HealthRow[]) {
            if (row.model_id != null && row.litellm_model_name != null) {
              nameByModelId.set(String(row.model_id), String(row.litellm_model_name));
            }
          }
          for (const p of points) {
            const name = nameByModelId.get(p.group);
            if (name !== undefined) p.litellm_model_name = name;
          }
        }
        // --- D5: dead-scrape detection -------------------------------------
        // The rule lives in `scrapeStatus`; this block only decides whether we are
        // allowed to apply it. UNKNOWN — query failed, no row, or a row that does
        // not carry the two columns we asked for — means we know nothing about the
        // scrape, so nothing is stamped and the measured values are served as-is.
        const scrapeRow = (scrape.rows as ScrapeHealthRow[])[0];
        const scrapeKnown =
          scrapeRow !== undefined && "last_up_ts" in scrapeRow && "last_seen_ts" in scrapeRow;
        // LIVENESS: did the scraper write ANY health row recently (up or not)?
        // This drives the down/up determination, stamping, and the
        // X-Scrape-Down / X-Scrape-Staleness-Ms headers.
        // SUCCESS: did a target succeed recently (last row with up=true)?
        // This is diagnostic-only and feeds X-Scrape-Last-Success.
        const nowMs = Date.now();
        const liveness = scrapeKnown
          ? scrapeStatus(scrapeRow.last_seen_ts ?? null, nowMs, SCRAPE_DOWN_AFTER_MS)
          : null;
        const success = scrapeKnown
          ? scrapeStatus(scrapeRow.last_up_ts ?? null, nowMs, SCRAPE_DOWN_AFTER_MS)
          : null;
        if (liveness !== null && liveness.up === false) {
          // Every value in this response is a guess. Replace the health-derived
          // states with known-nothing zeros so nothing here ranks, averages, or
          // can be read as a genuinely idle fleet.
          points = stampScrapeDown(points);
        }
        // The exempt set: every group present in deployment_inventory for this
        // axis, from the failure-tolerant fifth query (so it may legitimately be
        // empty, and is empty for an axis with no inventory axis).
        const inventoryGroups = new Set<string>();
        for (const row of inventory.rows as InventoryGroupRow[]) {
          if (row.grp !== null && row.grp !== undefined) inventoryGroups.add(String(row.grp));
        }
        // LAST transformation before the response, deliberately: the scrape-down
        // stamping above runs BEFORE this, and the cap then keeps every synthetic
        // point (unknowns are never truncated).
        const capped = applyTopN(points, TOP_N, inventoryGroups);
        // Staleness travels in HEADERS, not the body: the live web parses a bare
        // JSON array, and changing it to an object is a Phase 3 decision. An empty
        // header value means "unknown".
        const stalenessMs = liveness?.stalenessMs;
        sendJson(res, 200, capped, {
          "X-Scrape-Last-Success": success?.lastScrapeTs ?? "",
          "X-Scrape-Down": liveness === null ? "unknown" : String(!liveness.up),
          "X-Scrape-Staleness-Ms":
            stalenessMs === null || stalenessMs === undefined ? "" : String(stalenessMs),
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("series query failed:", message);
        sendJson(res, 500, { error: "internal error" });
      });
  };
}

// ===========================================================================
// Bootstrap (runs only when executed directly via tsx, never under test)
// ===========================================================================

/** Resolve the DATABASE_URL from the standard Postgres env vars used by
 *  docker-compose.yml / .env.example. */
function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const db = process.env.POSTGRES_DB ?? "litellm";
  const user = process.env.POSTGRES_USER ?? "litellm";
  const password = process.env.POSTGRES_PASSWORD ?? "litellm";
  const host = process.env.PGHOST ?? "localhost";
  const port = process.env.PGPORT ?? "5432";
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

/** True when this module is the program entry point (tsx runs the file
 *  directly). Under the test runner the imported module is never "main", so
 *  the test suite never opens a DB connection. */
function isRunningAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    return resolve(entry) === here;
  } catch {
    return false;
  }
}

if (isRunningAsMain()) {
  const pool = new Pool({ connectionString: resolveDatabaseUrl() });
  // Adapt pg's promise-based query() to the plain QueryFn shape the handler
  // expects. pg's `QueryResult` (typed by @types/pg) is structurally
  // compatible with `{ rows: any[] }`, so no cast is required.
  const query: QueryFn = (sql, params) => pool.query(sql, params);
  const server = createServer(createRequestHandler({ query }));
  const port = Number(process.env.API_PORT ?? 8080);
  server.listen(port, () => {
    console.log(`api listening on :${port}`);
  });
  // TTFT/ghost classifier: verdicts for the decode-rate correction and the
  // real-backend sanity check. Runs at start, on the periodic cadence, and on
  // any deployment_inventory change (new/updated model at LiteLLM). A failed
  // run only logs — series queries degrade to uncorrected rates until the next
  // trigger, never to errors.
  startTtftClassifierScheduler(query);
}
