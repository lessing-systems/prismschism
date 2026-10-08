// Deterministic mock fleet for `MOCK_API=true`. Serves the series the fleet
// panel reads (requests, errors, decode_tps, input_tps, aggregate_output_tps,
// request_wall_clock, requests_per_min) for a small, generic self-hosted
// setup: five front-end models backed by six deployments. Values are seeded
// per (id, metric, bucket), so repeated calls in the same bucket return
// identical numbers. `aggregate_output_tps` and `request_wall_clock` must be
// served here too — the panel's Fleet Aggregate tile and the per-card
// Wall-clock stat read them, and a 400/undefined from the mock would surface
// as a broken tile/stat in mock mode.
import type { MetricPoint, MetricPointState, Range } from "../lib/types";

export type FleetGroup = "model" | "api_provider" | "model_id";

interface Deployment {
  id: string;
  model: string;
  upstream: string;
  provider: string;
  decode: number; // tokens/s while decoding (per-stream frame)
  duty: number; // fraction of wall-clock the deployment spends decoding
  ttft: number; // seconds of queue+prefill+first token per request
  input: number; // input tokens/s
  rpm: number; // requests per minute
  idleEvery: number; // roughly every Nth bucket is idle (0 = never)
}

const DEPLOYMENTS: Deployment[] = [
  { id: "chat-llama-70b-a", model: "chat", upstream: "llama-3.3-70b-instruct", provider: "openai", decode: 41, duty: 0.32, ttft: 1.4, input: 620, rpm: 11, idleEvery: 0 },
  { id: "chat-llama-70b-b", model: "chat", upstream: "llama-3.3-70b-instruct", provider: "openai", decode: 38, duty: 0.28, ttft: 1.6, input: 560, rpm: 9, idleEvery: 11 },
  { id: "coder-qwen-32b-a", model: "coder", upstream: "qwen2.5-coder-32b", provider: "openai", decode: 76, duty: 0.38, ttft: 0.9, input: 1180, rpm: 14, idleEvery: 0 },
  { id: "coder-qwen-32b-b", model: "coder", upstream: "qwen2.5-coder-32b", provider: "openai", decode: 71, duty: 0.35, ttft: 1.1, input: 1040, rpm: 12, idleEvery: 9 },
  { id: "reasoner-r1-distill", model: "reasoner", upstream: "deepseek-r1-distill-70b", provider: "openai", decode: 27, duty: 0.45, ttft: 2.3, input: 410, rpm: 4, idleEvery: 7 },
  { id: "vision-qwen-vl", model: "vision", upstream: "qwen2.5-vl-32b", provider: "hosted_vllm", decode: 54, duty: 0.22, ttft: 2.0, input: 890, rpm: 5, idleEvery: 5 },
];

const BUCKETS: Record<Range, { stepMs: number; count: number }> = {
  "1h": { stepMs: 60_000, count: 60 },
  "24h": { stepMs: 300_000, count: 288 },
  "7d": { stepMs: 3_600_000, count: 168 },
};

function rand(key: string): number {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^= h >>> 16) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Slow wave + noise so charts look like real traffic rather than static.
function level(key: string, b: number): number {
  const wave = 0.8 + 0.25 * Math.sin(b / 9) + 0.12 * Math.sin(b / 3.1);
  return Math.max(0.05, wave * (0.8 + 0.4 * rand(key + "|" + b)));
}

function isIdle(d: Deployment, b: number): boolean {
  return d.idleEvery > 0 && rand(d.id + "|idle|" + b) < 1 / d.idleEvery / 2;
}

type Metric =
  | "requests"
  | "errors"
  | "decode_tps"
  | "input_tps"
  | "aggregate_output_tps"
  | "request_wall_clock"
  | "requests_per_min";

function deploymentValue(d: Deployment, metric: Metric, b: number): number {
  if (isIdle(d, b)) return 0;
  const l = level(d.id + metric, b);
  if (metric === "decode_tps") return round(d.decode * (0.85 + 0.3 * rand(d.id + "|d|" + b)));
  // Wall-clock frame: per-stream decode speed × the share of the bucket the
  // deployment actually spent decoding. TTFT is never a term here.
  if (metric === "aggregate_output_tps") return round(d.decode * d.duty * (0.85 + 0.3 * rand(d.id + "|agg|" + b)));
  // End-to-end request duration: the deployment's TTFT plus generation time
  // for a ~500-token response at its per-stream decode speed. Smaller decode
  // speed -> longer requests, matching reality.
  if (metric === "request_wall_clock") return round(d.ttft + 500 / d.decode + 2 * (rand(d.id + "|wc|" + b) - 0.5));
  if (metric === "input_tps") return round(d.input * l);
  return round(d.rpm * l); // requests_per_min / requests
}

const round = (n: number): number => Math.round(n * 10) / 10;

function stateOf(v: number, last: boolean, d?: Deployment): MetricPointState {
  if (v === 0) return "idle";
  return last && d?.id === "coder-qwen-32b-b" ? "prefill" : "healthy";
}

export function fleetSeries(metric: string, range: Range, group: FleetGroup): MetricPoint[] | null {
  const spec = BUCKETS[range];
  const base = Math.floor(Date.now() / spec.stepMs) - (spec.count - 1);
  const out: MetricPoint[] = [];

  if (metric === "errors") {
    for (const provider of ["openai", "hosted_vllm"]) {
      for (let i = 0; i < spec.count; i++) {
        const b = base + i;
        const spike = rand(provider + "|err|" + b) < 0.04;
        out.push({ t: new Date(b * spec.stepMs).toISOString(), group: provider, value: spike ? 1 + Math.floor(rand(provider + b) * 3) : 0, state: "healthy" });
      }
    }
    return out;
  }

  if (!["requests", "decode_tps", "input_tps", "aggregate_output_tps", "request_wall_clock", "requests_per_min"].includes(metric)) return null;
  const m = metric as Metric;

  if (group === "model_id") {
    for (const d of DEPLOYMENTS) {
      for (let i = 0; i < spec.count; i++) {
        const b = base + i;
        const v = deploymentValue(d, m, b);
        out.push({
          t: new Date(b * spec.stepMs).toISOString(),
          group: d.id,
          value: v,
          state: stateOf(v, i === spec.count - 1, d),
          litellm_model_name: d.upstream,
          in_inventory: true,
          ...(m === "input_tps" || m === "aggregate_output_tps" ? { unit: "token/s" } : m === "request_wall_clock" ? { unit: "s" } : undefined),
        });
      }
    }
    return out;
  }

  // group=model (and api_provider for completeness): roll deployments up.
  const key = (d: Deployment): string => (group === "api_provider" ? d.provider : d.model);
  const names = [...new Set(DEPLOYMENTS.map(key))];
  for (const name of names) {
    const members = DEPLOYMENTS.filter((d) => key(d) === name);
    for (let i = 0; i < spec.count; i++) {
      const b = base + i;
      const vals = members.map((d) => deploymentValue(d, m, b));
      const active = vals.filter((v) => v > 0);
      const sum = vals.reduce((a, v) => a + v, 0);
      // Decode rates and per-request wall-clock average over active members
      // (a group is not 2x faster because two members serve it); wall-clock
      // token rates (aggregate) and counts sum — concurrency adds up there.
      const v =
        m === "decode_tps" || m === "request_wall_clock"
          ? active.length
            ? round(sum / active.length)
            : 0
          : round(sum);
      out.push({
        t: new Date(b * spec.stepMs).toISOString(),
        group: name,
        value: v,
        state: stateOf(v, i === spec.count - 1, members[0]),
        ...(m === "input_tps" || m === "aggregate_output_tps" ? { unit: "token/s" } : m === "request_wall_clock" ? { unit: "s" } : undefined),
      });
    }
  }
  return out;
}
