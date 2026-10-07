// Pure contract tests for selectTopGroups() — no DOM, no mocks.
//
// Binding behavior (FleetMetricsPanel top-N selection):
//   * rank groups by summed REAL value, DESCENDING
//   * null/gap values contribute 0
//   * ERROR_SENTINEL points are EXCLUDED from totals (never inflate ranking)
//   * ties broken ALPHABETICALLY ascending (deterministic/stable)
//   * empty-string group "" gets label "unlabeled" (group field stays "")
//   * null/undefined/empty input, or n<=0, -> []
//
// selectTopGroups lives in the same file as these tests' import target
// (apps/web/src/lib/topGroups.ts). Kept pure: no side effects, order-independent.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOP_N,
  UNLABELED,
  UNKNOWN_DEPLOYMENT,
  deploymentLabel,
  requestLabel,
  selectTopGroups,
  type GroupLabeler,
} from '@/lib/topGroups';
import { ERROR_SENTINEL, type MetricPoint } from '@/lib/types';

function pt(group: string, value: number | null, t = 't0'): MetricPoint {
  return { t, group, value };
}

// Shuffles deterministically so the stability test is reproducible, not random.
function shuffled<T>(arr: T[], seed = 7): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    // mulberry32-style tiny PRNG for a reproducible shuffle
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = (seed >>> 0) % (i + 1);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

describe('selectTopGroups — ranking', () => {
  it('returns groups sorted by total value descending, limited to n', () => {
    const series: MetricPoint[] = [
      pt('a', 100),
      pt('b', 300),
      pt('c', 200),
      pt('d', 1000),
    ];
    const out = selectTopGroups(series, 2);
    expect(out).toEqual([
      { group: 'd', label: 'd', total: 1000 },
      { group: 'b', label: 'b', total: 300 },
    ]);
  });

  it('aggregates multiple points into one group total', () => {
    const series: MetricPoint[] = [
      pt('x', 50, 't1'),
      pt('x', 50, 't2'), // 50+50 = 100
      pt('y', 90, 't1'),
    ];
    const out = selectTopGroups(series, 2);
    expect(out.map((g) => [g.group, g.total])).toEqual([
      ['x', 100],
      ['y', 90],
    ]);
  });

  it('excludes null/gap values from totals (they contribute 0)', () => {
    const series: MetricPoint[] = [
      pt('a', 10),
      pt('a', null), // gap -> 0
      pt('b', 20),
      pt('b', null),
    ];
    const out = selectTopGroups(series, 2);
    expect(out.map((g) => [g.group, g.total])).toEqual([
      ['b', 20],
      ['a', 10],
    ]);
  });

  it('excludes ERROR_SENTINEL points from totals (sentinel must not inflate ranking)', () => {
    // 'big' has a huge REAL value; 'sentinel-only' has ONLY sentinel points.
    // Without sentinel exclusion, the sentinel (25) would wrongly contribute 75
    // and could steal a top-N slot. A group with NO real data is dropped
    // entirely — it must not occupy a slot, chart card, or legend entry.
    const series: MetricPoint[] = [
      pt('big', 100, 't1'),
      pt('big', 100, 't2'), // real total 200
      pt('sentinel-only', ERROR_SENTINEL, 't1'), // 25 (sentinel) — not real data
      pt('sentinel-only', ERROR_SENTINEL, 't2'),
      pt('sentinel-only', ERROR_SENTINEL, 't3'),
    ];
    const out = selectTopGroups(series, 2);
    // 'big' (200) is the only group with real data; 'sentinel-only' is dropped.
    expect(out.map((g) => [g.group, g.total])).toEqual([['big', 200]]);
    expect(out.some((g) => g.group === 'sentinel-only')).toBe(false);
  });

  it('a group whose only values are sentinels is DROPPED, never ranked beside real groups', () => {
    const series: MetricPoint[] = [
      pt('real', 50, 't1'),
      pt('real', 50, 't2'), // 100
      pt('all-sentinel', ERROR_SENTINEL, 't1'),
      pt('all-sentinel', ERROR_SENTINEL, 't2'),
      pt('all-sentinel', ERROR_SENTINEL, 't3'),
      pt('all-sentinel', ERROR_SENTINEL, 't4'),
    ];
    const out = selectTopGroups(series, 2);
    // 'all-sentinel' has no real data -> dropped; only 'real' remains.
    expect(out.map((g) => g.group)).toEqual(['real']);
  });
});

describe('selectTopGroups — tie-breaking', () => {
  it('breaks equal totals alphabetically ascending (deterministic, independent of input order)', () => {
    const base: MetricPoint[] = [pt('bravo', 50), pt('alpha', 50), pt('charlie', 50)];
    // Same totals (50 each). Expected: alpha, bravo, charlie — alphabetical.
    const outOriginal = selectTopGroups(base, 3).map((g) => g.group);
    const outShuffled = selectTopGroups(shuffled(base, 42), 3).map((g) => g.group);
    expect(outOriginal).toEqual(['alpha', 'bravo', 'charlie']);
    expect(outShuffled).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('keeps total order intact when totals differ (tie-break only on exact ties)', () => {
    const base: MetricPoint[] = [pt('zebra', 100), pt('ant', 200)];
    expect(selectTopGroups(base, 2).map((g) => g.group)).toEqual(['ant', 'zebra']);
    expect(selectTopGroups(shuffled(base, 99), 2).map((g) => g.group)).toEqual(['ant', 'zebra']);
  });
});

describe('selectTopGroups — labeling', () => {
  it('maps the empty-string group "" to label "unlabeled" (group field stays "")', () => {
    const series: MetricPoint[] = [pt('', 100), pt('real', 10)];
    const out = selectTopGroups(series, 2);
    const empty = out.find((g) => g.group === '');
    expect(empty).toBeDefined();
    expect(empty!.label).toBe(UNLABELED);
    expect(empty!.label).toBe('unlabeled');
    // Real group keeps its own label.
    expect(out.find((g) => g.group === 'real')!.label).toBe('real');
  });
});

describe('selectTopGroups — sizing & edge cases', () => {
  it('defaults to DEFAULT_TOP_N = 6 and caps at 6', () => {
    expect(DEFAULT_TOP_N).toBe(6);
    const series: MetricPoint[] = Array.from({ length: 8 }, (_, i) => pt(`g${i}`, (i + 1) * 10));
    const out = selectTopGroups(series); // default n=6
    expect(out.length).toBe(6);
  });

  it('returns [] for empty-array input', () => {
    expect(selectTopGroups([], 6)).toEqual([]);
  });

  it('returns [] for null input', () => {
    expect(selectTopGroups(null as unknown as MetricPoint[], 6)).toEqual([]);
  });

  it('returns [] for undefined input', () => {
    expect(selectTopGroups(undefined, 6)).toEqual([]);
  });

  it('returns [] when n <= 0', () => {
    const series: MetricPoint[] = [pt('a', 10), pt('b', 20)];
    expect(selectTopGroups(series, 0)).toEqual([]);
    expect(selectTopGroups(series, -3)).toEqual([]);
  });

  it('returns ALL groups when n exceeds the group count', () => {
    const series: MetricPoint[] = [pt('a', 10), pt('b', 20), pt('c', 30)];
    const out = selectTopGroups(series, 100);
    expect(out.map((g) => g.group)).toEqual(['c', 'b', 'a']);
  });
});

describe('selectTopGroups — stability', () => {
  it('produces identical output order for the same set of points in any input order', () => {
    const series: MetricPoint[] = [
      pt('Qwen3.8-27B-Q3_K_M.gguf', 500),
      pt('halogen-qwen3.8-flash-next', 350),
      pt('orchestration', 350),
      pt('tools', 120),
      pt('vision-tools', 80),
      pt('openai', 20),
      pt('None', 5),
      pt('', 40),
    ];
    const canonical = selectTopGroups(series, 8);
    const order = canonical.map((g) => g.group);
    // Expected: 500 > 350(tie: halogen < orchestration) > 120 > 80 > 40("") > 20 > 5.
    // Note: "" (40) outranks "openai" (20); ties only on EXACTLY equal totals.
    expect(order).toEqual([
      'Qwen3.8-27B-Q3_K_M.gguf',
      'halogen-qwen3.8-flash-next',
      'orchestration',
      'tools',
      'vision-tools',
      '',
      'openai',
      'None',
    ]);
    // Shuffled inputs (several seeds) must yield the exact same order.
    for (const seed of [1, 17, 99, 2026]) {
      expect(selectTopGroups(shuffled(series, seed), 8).map((g) => g.group)).toEqual(order);
    }
  });
});

// ---------------------------------------------------------------------------
// Deployment-side labeling (GREEN step under test).
//
// The FleetMetricsPanel now labels DEPLOYMENT series by the backend's real
// identity: `model_id · litellm_model_name` (U+00B7 middle dot, single spaces).
// The REQUEST-side behavior (empty group -> "unlabeled") is intentionally
// UNCHANGED. These blocks pin that contract. The implementation does not exist
// yet, so the new tests are expected to be RED until the GREEN step lands.
// ---------------------------------------------------------------------------

// Fixtures for the deployment-label tests (fixtures are fine; hardcoded name
// maps in the SOURCE implementation are not — labels must come from the series).
const MODEL_ID = 'orchestration-qwen38';
const MODEL_NAME = 'halogen-qwen3.8-flash-next';
const OTHER_ID = 'vision-tools-qwen3vl';
const OTHER_NAME = 'halogen-qwen3.8-vision-next';

// Local point builder for deployment-shaped series: optionally carries the
// backend model name (litellm_model_name). Does NOT touch the existing `pt`
// helper, which is used by the load-bearing tests above.
function dpt(group: string, value: number | null, name?: string, t = 't0'): MetricPoint {
  const p: MetricPoint = { t, group, value };
  if (name !== undefined) p.litellm_model_name = name;
  return p;
}

// request-side fallback must stay exactly as-is: only the empty-string group
// maps to "unlabeled"; every other group passes through verbatim (even the
// literal string "unlabeled"). This guards that the deployment labeler never
// leaks into the request path.
describe('requestLabel — request-side fallback (must stay exactly as-is)', () => {
  it('maps the empty group "" to the request-side "unlabeled" fallback', () => {
    expect(requestLabel('')).toBe(UNLABELED);
    expect(requestLabel('')).toBe('unlabeled');
  });

  it('passes non-empty groups through verbatim, including the literal string "unlabeled"', () => {
    expect(requestLabel('some-group')).toBe('some-group');
    // Request side is untouched: a group literally named "unlabeled" stays as-is.
    expect(requestLabel('unlabeled')).toBe('unlabeled');
  });
});

// deploymentLabel composes the backend identity `model_id · litellm_model_name`.
// Missing/empty/whitespace-only names (and names carried on other groups) fall
// back to the bare model_id. The separator is the U+00B7 MIDDLE DOT with single
// spaces — NOT the U+2022 bullet.
describe('deploymentLabel — backend identity `model_id · litellm_model_name`', () => {
  it('composes both parts with the U+00B7 middle dot (single spaces on each side)', () => {
    const label = deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10, MODEL_NAME)] });
    expect(label).toBe('orchestration-qwen38 \u00B7 halogen-qwen3.8-flash-next');
    // Pin the exact separator codepoint and rule out look-alikes.
    expect(label).toBe(`${MODEL_ID} \u00B7 ${MODEL_NAME}`);
    expect(label).not.toContain('\u2022'); // not the U+2022 bullet
    expect(label).not.toContain('\u00B7\u00B7'); // no doubled middle dot
  });

  it('falls back to the bare model_id when the point carries no name', () => {
    const label = deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10)] });
    expect(label).toBe(MODEL_ID);
  });

  it('falls back to the bare model_id when the name is an empty string', () => {
    const label = deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10, '')] });
    expect(label).toBe(MODEL_ID);
  });

  it('treats whitespace-only names as missing (falls back to the bare model_id)', () => {
    expect(deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10, '   ')] })).toBe(MODEL_ID);
    expect(deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10, '\t\t')] })).toBe(MODEL_ID);
  });

  it('does not compose when the name equals the model_id (no "x \u00B7 x" duplication)', () => {
    const label = deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10, MODEL_ID)] });
    expect(label).toBe(MODEL_ID);
    expect(label).not.toContain(' \u00B7 ');
  });

  it('ignores names carried on points belonging to a DIFFERENT group', () => {
    const label = deploymentLabel(MODEL_ID, { points: [dpt(OTHER_ID, 5, OTHER_NAME)] });
    expect(label).toBe(MODEL_ID);
  });

  it('maps the empty group "" to UNKNOWN_DEPLOYMENT (never "unlabeled")', () => {
    const label = deploymentLabel('', { points: [] });
    expect(label).toBe(UNKNOWN_DEPLOYMENT);
    expect(label).toBe('unknown-deployment');
    expect(label).not.toBe('unlabeled');
  });

  it('maps whitespace-only groups to UNKNOWN_DEPLOYMENT (treated as missing)', () => {
    for (const g of [' ', '  ', '\t']) {
      expect(deploymentLabel(g, { points: [] })).toBe(UNKNOWN_DEPLOYMENT);
    }
  });

  it('NEVER returns or contains "unlabeled" for any input (structural invariant)', () => {
    const cases: Array<() => string> = [
      () => deploymentLabel('', { points: [] }),
      () => deploymentLabel(' ', { points: [] }),
      () => deploymentLabel('\t', { points: [] }),
      () => deploymentLabel('unlabeled', { points: [] }),
      () => deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10)] }),
      () => deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10, MODEL_NAME)] }),
      () => deploymentLabel(MODEL_ID, { points: [dpt(MODEL_ID, 10, 'unlabeled')] }),
      () => deploymentLabel(OTHER_ID, { points: [dpt(OTHER_ID, 5, OTHER_NAME)] }),
      () => deploymentLabel('x', { points: [dpt('x', 1)] }),
    ];
    for (const make of cases) {
      const label = make();
      // The request-side "unlabeled" sentinel must never appear on the
      // deployment side — neither as the whole label nor embedded inside it.
      expect(label).not.toBe('unlabeled');
      expect(label).not.toContain('unlabeled');
    }
  });

  it('lets the FIRST non-empty name in scan order win', () => {
    const points: MetricPoint[] = [
      dpt(MODEL_ID, 1, ''),
      dpt(MODEL_ID, 1, '   '),
      dpt(MODEL_ID, 1, MODEL_NAME),
      dpt(MODEL_ID, 1, 'other-name'),
    ];
    const label = deploymentLabel(MODEL_ID, { points });
    expect(label).toBe(`${MODEL_ID} \u00B7 ${MODEL_NAME}`);
  });

  it('is pure: identical input -> identical output, and never mutates ctx.points', () => {
    const points: MetricPoint[] = [
      dpt(MODEL_ID, 10, MODEL_NAME),
      dpt(MODEL_ID, 20, ''),
      dpt(MODEL_ID, null),
    ];
    const before = JSON.stringify(points);
    const once = deploymentLabel(MODEL_ID, { points });
    const twice = deploymentLabel(MODEL_ID, { points });
    // (a) deterministic — same string on every call.
    expect(once).toBe(twice);
    // (b) ctx.points is not mutated (same JSON snapshot, same length).
    expect(JSON.stringify(points)).toBe(before);
    expect(points.length).toBe(3);
  });

  it('falls back to the bare model_id when the points array is empty', () => {
    const label = deploymentLabel(MODEL_ID, { points: [] });
    expect(label).toBe(MODEL_ID);
  });
});

// selectTopGroups grows an optional 3rd argument (a GroupLabeler) that
// replaces the built-in labeling step. The default (requestLabel) behavior is
// unchanged; a deploymentLabel (or any custom labeler) composes identity
// labels. Critically, the labeler only affects the `label` field — ranking
// (group, total) is untouched, and the deployment side must never emit the
// request-side "unlabeled" sentinel.
describe('selectTopGroups — deployment labeler seam', () => {
  it('emits composed "model_id \u00B7 name" labels while keeping raw model_ids and totals', () => {
    const series: MetricPoint[] = [
      dpt(MODEL_ID, 300, MODEL_NAME),
      dpt(OTHER_ID, 200, OTHER_NAME),
    ];
    const out = selectTopGroups(series, 2, deploymentLabel);
    expect(out.map((g) => g.label)).toEqual([
      `${MODEL_ID} \u00B7 ${MODEL_NAME}`,
      `${OTHER_ID} \u00B7 ${OTHER_NAME}`,
    ]);
    // Raw group fields remain the backend model_ids...
    expect(out.map((g) => g.group)).toEqual([MODEL_ID, OTHER_ID]);
    // ...and totals are unchanged.
    expect(out.map((g) => g.total)).toEqual([300, 200]);
  });

  it('never emits the banned "unlabeled" sentinel on the deployment side', () => {
    const series: MetricPoint[] = [
      dpt(MODEL_ID, 300, MODEL_NAME),
      dpt(OTHER_ID, 200, OTHER_NAME),
      dpt('', 50), // empty group
      dpt(MODEL_ID, null),
    ];
    const out = selectTopGroups(series, 6, deploymentLabel);
    // The request-side sentinel must not leak into any deployment label.
    expect(JSON.stringify(out)).not.toContain('unlabeled');
    // The empty group is relabeled to UNKNOWN_DEPLOYMENT, but its `group`
    // field stays the raw "".
    const empty = out.find((g) => g.group === '');
    expect(empty).toBeDefined();
    expect(empty!.label).toBe(UNKNOWN_DEPLOYMENT);
    expect(empty!.group).toBe('');
  });

  it('leaves ranking (group, total pairs + order) unaffected by the labeler', () => {
    const series: MetricPoint[] = [
      dpt(MODEL_ID, 300, MODEL_NAME),
      dpt(OTHER_ID, 200, OTHER_NAME),
      dpt('', 50),
      dpt(MODEL_ID, null),
    ];
    const withLabeler = selectTopGroups(series, 6, deploymentLabel)
      .map((g) => [g.group, g.total]);
    const defaultOut = selectTopGroups(series, 6).map((g) => [g.group, g.total]);
    expect(withLabeler).toEqual(defaultOut);
  });

  it('passes the FULL series as ctx.points to the labeler', () => {
    const seen: number[] = [];
    const capturing: GroupLabeler = (g, ctx) => {
      seen.push(ctx.points.length);
      return g;
    };
    const series: MetricPoint[] = [
      dpt('g1', 10),
      dpt('g2', 20),
      dpt('g3', 30),
      dpt('g4', 40),
    ];
    selectTopGroups(series, 6, capturing);
    // Every labeler call receives the complete 4-point series...
    for (const len of seen) {
      expect(len).toBe(4);
    }
    // ...and is invoked once per distinct group (4 groups -> 4 calls).
    expect(seen.length).toBe(4);
  });

  it('reproduces the default output exactly when requestLabel is passed explicitly', () => {
    const series: MetricPoint[] = [
      dpt('', 40),
      dpt('alpha', 100),
      dpt('beta', 60),
    ];
    const explicit = selectTopGroups(series, 6, requestLabel);
    const defaultOut = selectTopGroups(series, 6);
    expect(explicit).toEqual(defaultOut);
  });

  it('applies a custom labeler to every group while leaving group fields untouched', () => {
    const series: MetricPoint[] = [
      dpt('low', 10),
      dpt('mid', 20),
      dpt('', 30),
    ];
    const upper: GroupLabeler = (g) => g.toUpperCase() || 'FALLBACK';
    const out = selectTopGroups(series, 6, upper);
    // Every label is transformed by the custom labeler...
    for (const g of out) {
      expect(g.label).toBe(g.group.toUpperCase() || 'FALLBACK');
    }
    // ...including the empty group, which a request-style labeler would rename.
    expect(out.find((x) => x.group === '')!.label).toBe('FALLBACK');
    // Raw group fields are preserved verbatim (labeler never rewrites them).
    expect(out.map((x) => x.group).sort()).toEqual(['', 'low', 'mid']);
  });
});

// Regression guard: with NO third argument the built-in (request-side)
// labeler is used, so the empty group still maps to "unlabeled" and named
// deployment points are NOT composed.
describe('selectTopGroups — default labeler regression guard', () => {
  it('defaults to the request-side labeler: empty group -> "unlabeled", group stays ""', () => {
    const series: MetricPoint[] = [pt('', 100), pt('real', 10)];
    const out = selectTopGroups(series, 2); // no 3rd arg -> default labeler
    const empty = out.find((g) => g.group === '');
    expect(empty).toBeDefined();
    expect(empty!.label).toBe(UNLABELED);
    expect(empty!.label).toBe('unlabeled');
    expect(empty!.group).toBe('');
  });

  it('does NOT compose names under the default labeler, even when points carry names', () => {
    const series: MetricPoint[] = [
      dpt(MODEL_ID, 300, MODEL_NAME),
      dpt(OTHER_ID, 200, OTHER_NAME),
    ];
    const out = selectTopGroups(series, 6); // default labeler (requestLabel)
    // No " · " composition anywhere: labels are bare model_ids.
    expect(JSON.stringify(out)).not.toContain(' \u00B7 ');
    expect(out.map((g) => g.label)).toEqual([MODEL_ID, OTHER_ID]);
  });
});
