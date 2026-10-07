// The "current" traffic-light state of one group, for card badges and the
// summary strip.
//
// Why not simply the last point's state: LiteLLM increments its token and
// latency counters when a request COMPLETES, so a bucket only reads "healthy"
// if a request finished inside it. The newest bucket is usually still in
// progress (and so usually idle), and request-side series come from continuous
// aggregates that lag the raw deployment series by a minute or two. Taking each
// series' last point therefore compared different moments and made busy
// backends flicker to idle between completions.
//
// Instead every group is judged against the SAME wall-clock window: the most
// significant state among points stamped within `CURRENT_WINDOW_MS` (+ one
// bucket width, so a coarse 5m/1h bucket that started before the window still
// counts) of `now`. Precedence: error > healthy > prefill > idle. When no point
// falls in the window (a lagging or sparse series) the last stated point wins.
//
// This is still completion-based. A long generation reads idle until it ends;
// a true "streaming right now" signal needs LiteLLM's in-flight gauge, which
// the scraper does not collect yet.
import type { MetricPoint, MetricPointState } from "@/lib/types";

export const CURRENT_WINDOW_MS = 3 * 60_000;

const RANK: Record<MetricPointState, number> = { idle: 0, prefill: 1, healthy: 2, error: 3 };

/** Smallest positive gap between distinct timestamps, i.e. the bucket width. */
function bucketWidthMs(points: MetricPoint[]): number {
  const ts = [...new Set(points.map((p) => Date.parse(p.t)).filter(Number.isFinite))].sort((a, b) => a - b);
  let best = Infinity;
  for (let i = 1; i < ts.length; i += 1) best = Math.min(best, ts[i] - ts[i - 1]);
  return Number.isFinite(best) ? best : 0;
}

export function currentState(points: MetricPoint[], now: number = Date.now()): MetricPointState | undefined {
  const since = now - CURRENT_WINDOW_MS - bucketWidthMs(points);
  let best: MetricPointState | undefined;
  let latest: { at: number; state: MetricPointState } | undefined;
  for (const p of points) {
    if (!p.state) continue;
    const at = Date.parse(p.t);
    if (!Number.isFinite(at)) continue;
    if (!latest || at >= latest.at) latest = { at, state: p.state };
    if (at >= since && (best === undefined || RANK[p.state] > RANK[best])) best = p.state;
  }
  return best ?? latest?.state;
}
