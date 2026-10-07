// Deterministic mock data generator for the Prismschism (frontend mock).
// Pure TypeScript, no runtime dependencies. Values are seeded from a string
// hash + mulberry32 PRNG so two calls within the same time bucket return
// IDENTICAL numbers (keeps smoke tests stable).
//
// Design:
//   - 10 models across 4 providers (MODELS table).
//   - "gpt-4-turbo" is the DOWN model: its points are OMITTED (never 0, never
//     null) during a trailing outage window and present normally outside it,
//     so the chart shows a real gap rather than a zero or a break to null.
//   - "llama-3.1-70b" is the IDLE model: it emits real zeros at every timestamp.
//   - Bucket index b = floor(ms / stepMs); a value is keyed by
//     hash(model + metric + bucketIndex), so values are stable per bucket.
//   - KPIs and breakdowns EXCLUDE the down model (its traffic/latency don't
//     count toward aggregate health while it's down).
//   - Per-request cost/token constants are scaled by RANGE (usdScale/tokScale)
//     so each range's spend/token KPI lands in its spec'd ballpark.

import type {
  Range,
  Metric,
  TrafficLightState,
  MetricPoint,
  MetricPointState,
  Kpi,
  Breakdown,
  DeploymentHealth,
  StreamSnapshot,
} from "../lib/types";
import { ERROR_SENTINEL, isErrorSentinel } from "../lib/types";

export type GroupBy = "model" | "api_provider";

export const DOWN_MODEL = "gpt-4-turbo";
export const IDLE_MODEL = "llama-3.1-70b";

interface ModelSpec {
  name: string;
  provider: string;
  rps: number;
  err: number;
  usd: number;
  tok: number;
  lat: number;
}

const MODELS: ModelSpec[] = [
  { name: "gpt-4o",                    provider: "openai",    rps: 2.80, err: 0.01,  usd: 0.0016, tok: 60,  lat: 420 },
  { name: "gpt-4o-mini",               provider: "openai",    rps: 4.60, err: 0.005, usd: 0.00014, tok: 50,  lat: 190 },
  { name: "gpt-4-turbo",               provider: "openai",    rps: 1.10, err: 0.015, usd: 0.0045,  tok: 90,  lat: 520 },
  { name: "claude-3-5-sonnet-20240620",provider: "anthropic", rps: 1.95, err: 0.02,  usd: 0.0025,  tok: 70,  lat: 780 },
  { name: "claude-3-opus-20240229",    provider: "anthropic", rps: 0.70, err: 0.06,  usd: 0.010,   tok: 110, lat: 880 },
  { name: "claude-3-haiku",            provider: "anthropic", rps: 2.50, err: 0.008, usd: 0.00006, tok: 55,  lat: 240 },
  { name: "gemini-1.5-pro",            provider: "google",    rps: 1.05, err: 0.012, usd: 0.0011,  tok: 70,  lat: 560 },
  { name: "gemini-1.5-flash",          provider: "google",    rps: 2.10, err: 0.006, usd: 0.00008, tok: 55,  lat: 210 },
  { name: "llama-3.1-70b",             provider: "cohere",    rps: 0.0,  err: 0.0,   usd: 0.0002,  tok: 70,  lat: 300 },
  { name: "mistral-large",             provider: "cohere",    rps: 0.70, err: 0.018, usd: 0.0008,  tok: 55,  lat: 620 },
];

interface Bucket {
  stepMs: number;
  count: number;
}

const BUCKETS: Record<Range, Bucket> = {
  "1h": { stepMs: 300000, count: 12 }, // 5-min steps
  "24h": { stepMs: 1800000, count: 48 }, // 30-min steps
  "7d": { stepMs: 14400000, count: 42 }, // 4-hour steps
};

// Per-request cost/token multipliers per range so each KPI lands in spec.
const USD_SCALE: Record<Range, number> = { "1h": 0.33, "24h": 0.24, "7d": 0.21 };
const TOK_SCALE: Record<Range, number> = { "1h": 0.35, "24h": 0.18, "7d": 0.30 };

// Outage window per range for the DOWN model (points inside are omitted).
const OUTAGE_MS: Record<Range, number> = { "1h": 1800000, "24h": 7200000, "7d": 21600000 };

// Error window per range: buckets just before the outage get state:"error" + ERROR_SENTINEL. 7d uses a full stepMs band to guarantee >=1 error bucket.
const ERROR_WINDOW_MS: Record<Range, number> = { "1h": 600000, "24h": 2400000, "7d": 14400000 };

// --- deterministic PRNG ---------------------------------------------------
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1);
    t = (t + Math.imul(t ^ (t >>> 7), 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One deterministic [0,1) sample keyed by a string.
function rand(key: string): number {
  return mulberry32(hashString(key))();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Deterministic segment overlay applied to EVERY served series so each window
// contains, at FIXED index positions (pure function of series length — never
// probability), regardless of what the random generator produced:
//   - idle zero-run : value 0, state "idle"           (>= 3 consecutive)
//   - gap run       : value null, state undefined     (>= 3 consecutive)
//   - error run     : ERROR_SENTINEL, state "error"   (>= 2 consecutive)
// Invariant: simulated failure/down is ONLY ever null (gap) or
// ERROR_SENTINEL+"error" — never a synthetic 0. Zero means idle/healthy-quiet.
// Index placement keeps screenshots reproducible within a wall-clock bucket.
function guaranteeSegments(pts: MetricPoint[]): MetricPoint[] {
  const n = pts.length;
  if (n < 12) return pts; // segments need non-overlapping room: [~15%..+3) [~50%..+3) [~75%..+2)
  const zeroStart = Math.floor(n * 0.15);
  const nullStart = Math.floor(n * 0.5);
  const errStart = Math.floor(n * 0.75);
  // Sentinel-collision guard: a genuine (healthy) value that happens to equal
  // ERROR_SENTINEL would be indistinguishable from an error point. Bump such
  // values by +1 so value===ERROR_SENTINEL <=> state==="error", always.
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (p.value === ERROR_SENTINEL && p.state !== "error") {
      pts[i] = { ...p, value: p.value + 1 };
    }
  }
  for (let i = 0; i < 3; i++) {
    pts[zeroStart + i] = { ...pts[zeroStart + i], value: 0, state: "idle" };
    pts[nullStart + i] = { ...pts[nullStart + i], value: null, state: undefined };
  }
  for (let i = 0; i < 2; i++) {
    pts[errStart + i] = { ...pts[errStart + i], value: ERROR_SENTINEL, state: "error" };
  }
  return pts;
}

// Deterministic request count for one (model, bucket).
function requestsFor(m: ModelSpec, stepMs: number, b: number): number {
  const stepSeconds = stepMs / 1000;
  const key = m.name + "|requests|" + b;
  return Math.round(m.rps * stepSeconds * (0.7 + 0.6 * rand("req|" + key)));
}

// Value of one (model, metric, bucket). null => omitted (down-model gap);
// 0 => present zero (idle model).
function bucketValue(m: ModelSpec, metric: Metric, range: Range, stepMs: number, b: number): number | null {
  if (m.name === IDLE_MODEL) return 0;
  const bucketMs = b * stepMs;
  if (m.name === DOWN_MODEL && bucketMs > Date.now() - OUTAGE_MS[range]) return null;
  const reqs = requestsFor(m, stepMs, b);
  if (metric === "requests") return reqs;
  if (metric === "errors") return Math.max(0, Math.round(reqs * m.err));
  if (metric === "spend") return round4(reqs * m.usd * USD_SCALE[range]);
  if (metric === "tokens") return Math.round(reqs * m.tok * TOK_SCALE[range]);
  const key = m.name + "|latency|" + b;
  return Math.round(m.lat * (0.85 + 0.4 * rand("lat|" + key)));
}

// Points for a single model. The down model keeps real values for its healthy
// buckets, shows a visible gap (value null) during the outage window, and is
// tagged state:"error" (+ ERROR_SENTINEL) for its "requests" buckets that fall
// in the pre-outage error window. Every bucket yields exactly one point.
function modelSeries(m: ModelSpec, metric: Metric, range: Range): MetricPoint[] {
  const { stepMs, count } = BUCKETS[range];
  const baseBucket = Math.floor(Date.now() / stepMs) - (count - 1);
  const pts: MetricPoint[] = [];
  for (let i = 0; i < count; i++) {
    const b = baseBucket + i;
    const bucketMs = b * stepMs;
    const ageMs = Date.now() - bucketMs;
    // Pre-outage error band for the down model's request counts (deterministic
    // from bucket time alone).
    const inErrorWindow =
      m.name === DOWN_MODEL &&
      metric === "requests" &&
      ageMs >= OUTAGE_MS[range] &&
      ageMs < OUTAGE_MS[range] + ERROR_WINDOW_MS[range];

    let value: number | null;
    let state: MetricPointState | undefined;
    if (inErrorWindow) {
      value = ERROR_SENTINEL;
      state = "error";
    } else {
      value = bucketValue(m, metric, range, stepMs, b);
      if (value === null) state = undefined; // outage gap: leave state undefined
      else if (m.name === IDLE_MODEL) state = "idle";
      else if (m.name === "gpt-4o" && metric === "requests" && i < 3) state = "prefill";
      else state = "healthy";
    }
    pts.push({ t: new Date(bucketMs).toISOString(), group: m.name, value, state });
  }
  return pts;
}

export function seriesFor(metric: Metric, range: Range, group: GroupBy): MetricPoint[] {
  const { stepMs, count } = BUCKETS[range];
  const baseBucket = Math.floor(Date.now() / stepMs) - (count - 1);

  if (group === "model") {
    const out: MetricPoint[] = [];
    for (const m of MODELS) out.push(...guaranteeSegments(modelSeries(m, metric, range)));
    return out;
  }

  // api_provider: aggregate member models per bucket.
  const providers = new Set<string>();
  for (const m of MODELS) providers.add(m.provider);
  const membersByProvider = new Map<string, ModelSpec[]>();
  for (const m of MODELS) {
    const arr = membersByProvider.get(m.provider);
    if (arr) arr.push(m);
    else membersByProvider.set(m.provider, [m]);
  }

  const out: MetricPoint[] = [];
  providers.forEach((prov) => {
    const members = membersByProvider.get(prov) ?? [];
    const series: MetricPoint[] = [];
    for (let i = 0; i < count; i++) {
      const b = baseBucket + i;
      const t = new Date(b * stepMs).toISOString();
      if (metric === "latency") {
        // A down model has no successful calls to time, so it never weights
        // the average. Sum metrics below let it contribute (0 while down).
        let reqSum = 0;
        let latSum = 0;
        for (const m of members) {
          if (m.name === DOWN_MODEL) continue;
          const reqs = requestsFor(m, stepMs, b);
          reqSum += reqs;
          const key = m.name + "|latency|" + b;
          latSum += reqs * Math.round(m.lat * (0.85 + 0.4 * rand("lat|" + key)));
        }
        // Nothing to time => unknown gap, NEVER a synthetic 0.
        series.push({ t, group: prov, value: reqSum > 0 ? Math.round(latSum / reqSum) : null });
      } else {
        let total = 0;
        let anyPresent = false;
        for (const m of members) {
          const v = bucketValue(m, metric, range, stepMs, b);
          if (v !== null) {
            total += v;
            anyPresent = true;
          }
        }
        // Whole provider down => null gap, NEVER a synthetic 0.
        series.push({ t, group: prov, value: anyPresent ? total : null });
      }
    }
    out.push(...guaranteeSegments(series));
  });
  return out;
}

export function breakdownFor(metric: "spend" | "tokens", range: Range): Breakdown[] {
  const out: Breakdown[] = [];
  for (const m of MODELS) {
    const pts = modelSeries(m, metric, range);
    let total = 0;
    for (const p of pts) if (p.value !== null && !isErrorSentinel(p.value)) total += p.value;
    out.push({ label: m.name, value: metric === "spend" ? round4(total) : total });
  }
  return out;
}

function baseRpsSum(): number {
  let s = 0;
  for (const m of MODELS) s += m.rps;
  return s;
}

export function kpisFor(range: Range): Kpi {
  const { stepMs, count } = BUCKETS[range];
  const reqKey = range + "|kpi|req";
  const p95Key = range + "|kpi|p95";
  const rps = baseRpsSum() * (0.95 + 0.1 * rand(reqKey));

  let totalReq = 0;
  let totalErr = 0;
  let totalSpend = 0;
  let totalTok = 0;
  const latByReq: [number, number][] = [];
  for (const m of MODELS) {
    if (m.name === DOWN_MODEL) continue; // down model excluded from aggregate KPIs
    for (let i = 0; i < count; i++) {
      const b = Math.floor(Date.now() / stepMs) - (count - 1) + i;
      const reqs = requestsFor(m, stepMs, b);
      totalReq += reqs;
      totalErr += Math.max(0, Math.round(reqs * m.err));
      totalSpend += reqs * m.usd * USD_SCALE[range];
      totalTok += reqs * m.tok * TOK_SCALE[range];
      if (m.name !== IDLE_MODEL && reqs > 0) {
        const key = m.name + "|latency|" + b;
        latByReq.push([reqs, Math.round(m.lat * (0.85 + 0.4 * rand("lat|" + key)))]);
      }
    }
  }

  let latSum = 0;
  let latReq = 0;
  for (const [r, l] of latByReq) {
    latSum += r * l;
    latReq += r;
  }
  const weightedMs = latReq > 0 ? latSum / latReq : 0;
  // p95 sits above the request-weighted mean; tuned to land in 380-520ms.
  const p95 = Math.round(390 + 0.12 * weightedMs + 50 * rand(p95Key));

  return {
    rps: round4(rps),
    error_rate: round4(totalReq > 0 ? totalErr / totalReq : 0),
    spend_usd: round4(totalSpend),
    tokens: Math.round(totalTok),
    p95_ms: p95,
    healthy_deployments: 8,
  };
}

export function trafficLights(): DeploymentHealth[] {
  return MODELS.map((m) => {
    const id = m.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    if (m.name === DOWN_MODEL) {
      return { id, name: m.name, state: "error" as TrafficLightState };
    }
    if (m.name === IDLE_MODEL) {
      return { id, name: m.name, state: "idle" as TrafficLightState };
    }
    const state: TrafficLightState = m.name === "gemini-1.5-flash" ? "prefill" : "healthy";
    return { id, name: m.name, state, p50: m.lat, p95: Math.round(m.lat * 1.35), p99: Math.round(m.lat * 1.7) };
  });
}

export function snapshot(tick: number): StreamSnapshot {
  const base = kpisFor("1h");
  const key = (label: string) => tick + "|" + label;
  const kpis: Kpi = {
    ...base,
    rps: round4(base.rps * (1 + 0.02 * (rand(key("rps")) - 0.5))),
    error_rate: round4(base.error_rate * (1 + 0.12 * (rand(key("err")) - 0.5))),
    p95_ms: Math.round(base.p95_ms * (1 + 0.06 * (rand(key("p95")) - 0.5))),
  };
  const tpm = Math.round(1150000 + 220000 * rand(key("tpm")));
  return { kpis, trafficLights: trafficLights(), tpm };
}
