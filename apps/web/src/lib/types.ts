// Shared API + domain types for the prismschism web client (Task 3).
// Field names are binding to the backend API contract — do not rename.

// Time range union (kept as a small open-ish union; extend deliberately).
export type Range = "1h" | "24h" | "7d";

// Metric union aligned to the LiteLLM metric families (minimal set), plus the
// backend-derived throughput/rate metrics. `input_tps` is an input-TOKEN rate
// (renamed from a misleading prefill-based name — it is NOT true prefill
// throughput), `requests_per_min` is the per-backend served requests-per-
// minute rate, and `aggregate_output_tps` is the fleet wall-clock output rate
// (Σ output tokens / bucket seconds — the concurrency-inclusive frame; no TTFT
// enters it by construction). They all ride the same MetricPoint envelope, so
// they join this union instead of forking a type.
export type Metric =
  | "requests"
  | "errors"
  | "spend"
  | "tokens"
  | "latency"
  | "decode_tps"
  | "input_tps"
  | "aggregate_output_tps"
  | "requests_per_min";

// 5-state traffic light. Matches CSS tokens --healthy/--prefill/--error/--idle/--disabled.
export type TrafficLightState = "healthy" | "prefill" | "error" | "idle" | "disabled";

// Per-point state on series points. Deliberately EXCLUDES "disabled" from
// TrafficLightState: a series point is never a disabled deployment.
export type MetricPointState = "idle" | "error" | "healthy" | "prefill";

// Non-zero sentinel emitted on error-window points so charts render a visible
// (small) marker instead of dropping the point. Per-bucket magnitudes run ~1e2
// (1h) to ~1e4 (7d), so 25 stays a small, non-distorting fraction of the
// Y-scale yet is non-zero so bars/dots still render.
export const ERROR_SENTINEL = 25;

// Returns true when a point value is the error sentinel (null-safe).
export function isErrorSentinel(v: number | null): boolean {
  return v !== null && v === ERROR_SENTINEL;
}

// GET /api/series?metric=..&range=..&group=..  ->  [{ t, group, value, state? }]
export interface MetricPoint {
  t: string;
  group: string;
  value: number | null;
  state?: MetricPointState;
  // Display unit supplied by the API for derived throughput series
  // (e.g. "token/s" on decode_tps/input_tps). Absent on every other metric,
  // so the Y axis renders no label rather than inventing one.
  unit?: string;
  // LiteLLM-facing model name of the deployment identified by `group`
  // (model_id). Present on deployment-side series only; absent on request-side
  // series, where `group` is already the display label.
  litellm_model_name?: string;
  // Phase 2 additive fields. `in_inventory` is true when the row is backed by a
  // deployment_inventory row, i.e. the backend exists even at zero traffic
  // (value coalesced to 0). `synthetic` marks a scrape-down filler point, which
  // the API emits as state "error" + value 0 once no scrape has succeeded.
  in_inventory?: boolean;
  synthetic?: boolean;
}

// GET /api/kpis?range=..  ->  { rps, error_rate, spend_usd, tokens, p95_ms, healthy_deployments }
export interface Kpi {
  rps: number;
  error_rate: number;
  spend_usd: number;
  tokens: number;
  p95_ms: number;
  healthy_deployments: number;
}

// GET /api/breakdown?metric=..&range=..  ->  [{ label, value }]
export interface Breakdown {
  label: string;
  value: number;
}

// Health screen model (Task 9 consumes). Minimal + typed; percentiles optional.
export interface DeploymentHealth {
  id: string;
  name: string;
  state: TrafficLightState;
  p50?: number;
  p95?: number;
  p99?: number;
}

// SSE snapshot pushed on GET /api/stream via the default (unnamed) "message" event.
// NOTE: the docs do NOT enumerate the snapshot schema (contract gap). This is the
// agreed shape for the Task 4 mock stream. All fields optional to allow partial pushes.
export interface StreamSnapshot {
  kpis?: Kpi;
  trafficLights?: DeploymentHealth[];
  tpm?: number;
}
