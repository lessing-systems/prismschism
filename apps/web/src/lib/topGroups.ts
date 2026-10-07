// Pure top-N group selector for the FleetMetricsPanel.
//
// Given a MetricPoint series (already grouped), it aggregates REAL values per
// distinct `group`, ranks them, and returns the leading n groups for display.
//
// Ranking contract (binding for the panel):
//   * total = sum of point values where value is a FINITE number AND is NOT the
//     error sentinel. ERROR_SENTINEL (25) marks error-window points and must NOT
//     inflate a group's ranking.
//   * null/gap values (value === null) contribute 0.
//   * Sort by total DESCENDING; exact ties broken ALPHABETICALLY ascending by
//     group name. We use plain codepoint (lexicographic) comparison rather than
//     localeCompare so the ordering is byte-for-byte deterministic across
//     environments/locales — a stability requirement, not an aesthetic choice.
//   * label = group, EXCEPT the empty-string group "" -> "unlabeled" (the
//     group field itself stays "").
//
// Pure + order-independent: same set of points -> same output regardless of
// input ordering. No side effects, no DOM, no I/O.

import { isErrorSentinel, type MetricPoint } from "@/lib/types";

export interface TopGroup {
  group: string;
  label: string;
  total: number;
}

// Display label for the empty-string group (mock-era aggregate bucket).
export const UNLABELED = "unlabeled";

// Top-N = 6. Rationale: the fleet legend paints its series with exactly SIX
// dedicated legend colors -- --legend-1 .. --legend-6 in index.css (the
// categorical data-viz scale). Capping the panel at 6 groups guarantees every
// displayed series maps to a DISTINCT legend color with no cycling/aliasing —
// one unambiguous color per group. The legend scale is deliberately separate
// from the traffic-light tokens so a series color is never misread as a state.
//
// NOTE: DEFAULT_TOP_N is the library default argument and the size of the legend
// colour scale — it is NOT the fleet panel's display cap any more. The panel
// displays up to PANEL_TOP_N cards (20, matching the API default) while the
// legend stays at LEGEND_MAX swatches so every swatch keeps a distinct colour.
export const DEFAULT_TOP_N = 6;

// Panel display cap: raised to 20 to match the API's default top-N, and
// configurable at runtime via VITE_TOP_N. Values above MAX_TOP_N are clamped so a
// typo cannot render an unbounded wall of cards; non-numeric / non-positive
// values fall back to MAX_TOP_N.
export const MAX_TOP_N = 20;
export const LEGEND_MAX = 6;

function readPanelTopN(): number {
  const raw = import.meta.env.VITE_TOP_N;
  if (raw == null || raw === "") return MAX_TOP_N;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_TOP_N;
  return Math.min(parsed, MAX_TOP_N);
}

export const PANEL_TOP_N = readPanelTopN();

// Deployment-side counterpart to UNLABELED. A deployment series with no usable
// model_id is a DATA DEFECT, not an aggregate bucket, so it gets its own token
// and the request-side "unlabeled" sentinel is structurally impossible here.
export const UNKNOWN_DEPLOYMENT = "unknown-deployment";

// Labeler seam: maps a raw `group` to its display label. `ctx.points` is the
// FULL original series (NOT the group's own subset), so a labeler can look up
// per-group metadata without extra plumbing; it may also ignore ctx entirely.
// Implementations must be pure + deterministic and must never mutate ctx.points.
export type GroupLabeler = (group: string, ctx: { points: MetricPoint[] }) => string;

// Request-side labeler — the historical built-in behavior: the empty-string
// group renders as "unlabeled", every other group passes through verbatim
// (including the literal string "unlabeled").
export function requestLabel(group: string): string {
  return group === "" ? UNLABELED : group;
}

// Deployment-side labeler: composes the backend identity
// `model_id · litellm_model_name` (U+00B7 middle dot, single spaces) using the
// FIRST point of THIS group that carries a usable name. Empty / whitespace-only
// groups and the request-side "unlabeled" sentinel map to UNKNOWN_DEPLOYMENT.
export function deploymentLabel(
  group: string,
  ctx: { points: MetricPoint[] },
): string {
  const t = group.trim();
  if (t === "" || t === UNLABELED) return UNKNOWN_DEPLOYMENT;

  // Scan in order for the first usable name on THIS group. Names carried on
  // other groups are irrelevant; empty/whitespace names and the literal
  // "unlabeled" name count as missing. Read-only pass — ctx.points is never
  // mutated.
  let name: string | undefined;
  for (const p of ctx.points) {
    if (p.group !== group) continue;
    const raw = p.litellm_model_name;
    if (typeof raw !== "string") continue;
    const candidate = raw.trim();
    if (candidate === "" || candidate === UNLABELED) continue;
    name = candidate;
    break;
  }

  // No usable name -> bare model_id. Name identical to the id -> no "x · x".
  if (name === undefined || name === group) return group;
  return `${group} \u00B7 ${name}`;
}

export function selectTopGroups(
  series: MetricPoint[] | null | undefined,
  n: number = DEFAULT_TOP_N,
  labeler: GroupLabeler = requestLabel,
): TopGroup[] {
  // Null/undefined/empty input, or a non-positive count, yields no groups.
  if (n <= 0 || series == null || series.length === 0) return [];

  // Aggregate REAL totals per distinct group.
  const totals = new Map<string, number>();
  for (const p of series) {
    const v = p.value;
    if (v == null) continue; // gap/null contributes 0
    if (!Number.isFinite(v)) continue; // defensive: ignore non-finite junk
    if (isErrorSentinel(v)) continue; // sentinel must not inflate ranking
    totals.set(p.group, (totals.get(p.group) ?? 0) + v);
  }

  const groups: TopGroup[] = [];
  for (const [group, total] of totals) {
    groups.push({ group, label: labeler(group, { points: series }), total });
  }

  // Descending by total; exact ties broken alphabetically ascending (codepoint).
  groups.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.group < b.group) return -1;
    if (a.group > b.group) return 1;
    return 0;
  });

  return groups.slice(0, n);
}
