import type { MetricPoint, MetricPointState } from '@/lib/types';

/** Placeholder rendered when a stat has no numeric data at all. */
export const EMPTY_STAT = '\u2014';

/**
 * Buckets that must never feed rate-style stats (RPM/TPS/token-rate).
 *
 * NOTE: the "disabled" state does not exist on MetricPoint yet — types.ts
 * deliberately leaves it out of MetricPointState (only TrafficLightState has
 * "disabled"). If the API ever stamps "disabled" onto series points it MUST be
 * added to this set, otherwise disabled deployments keep counting toward the
 * means below.
 */
export const EXCLUDED_RPM_STATES: ReadonlySet<MetricPointState> = new Set<MetricPointState>([
  'idle',
  'error',
]);

/** The non-null numeric values of a series, in source order. */
export function numericValues(points: MetricPoint[]): number[] {
  const values: number[] = [];
  for (const point of points) {
    if (point.value !== null) values.push(point.value);
  }
  return values;
}

/**
 * Mean of the non-null values. Null when nothing is numeric — an empty series
 * must render as EMPTY_STAT ("—"), never as 0.
 */
export function meanOf(points: MetricPoint[]): number | null {
  const values = numericValues(points);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Mean of the points whose state is not excluded. Null values are dropped too,
 * and points with no state at all are kept (undefined is neither idle nor error).
 */
export function meanExcludingStates(
  points: MetricPoint[],
  excluded: ReadonlySet<MetricPointState> = EXCLUDED_RPM_STATES,
): number | null {
  return meanOf(points.filter((point) => !excluded.has(point.state as MetricPointState)));
}

/**
 * Mean decode rate over ACTIVE buckets only: value > 0, not an error bucket and
 * not scrape-down filler. decode_tps is tokens per decode-second, so a bucket
 * with no decoding is "no observation", not a 0 t/s measurement — averaging the
 * idle zeros in would report a fraction of the real decode speed. Null when no
 * bucket decoded.
 */
export function meanOfActive(points: MetricPoint[]): number | null {
  return meanOf(
    points.filter(
      (p) => p.value !== null && p.value > 0 && p.state !== 'error' && p.synthetic !== true,
    ),
  );
}

/** Buckets points under their own `group` key, preserving source order. */
export function groupPointsByGroup(points: MetricPoint[]): Map<string, MetricPoint[]> {
  const grouped = new Map<string, MetricPoint[]>();
  for (const point of points) {
    const bucket = grouped.get(point.group);
    if (bucket) bucket.push(point);
    else grouped.set(point.group, [point]);
  }
  return grouped;
}

/**
 * Fleet "Combined Token/s (observed)": the sum over deployments of each
 * deployment's own average decode t/s (meanOfActive — idle buckets excluded).
 * A group that never decoded in the window has no mean and contributes
 * nothing; null only when no group yields a mean.
 */
export function combinedObservedTokenRate(decodePoints: MetricPoint[]): number | null {
  let total = 0;
  let counted = 0;
  for (const points of groupPointsByGroup(decodePoints).values()) {
    const mean = meanOfActive(points);
    if (mean === null) continue;
    total += mean;
    counted += 1;
  }
  return counted === 0 ? null : total;
}

/**
 * Highest fleet-wide decode rate on record: per time bucket, sum the decode t/s
 * of every deployment (error/synthetic filler excluded), then take the max
 * bucket. null when there is no usable bucket.
 */
export function maxCombinedTokenRate(decodePoints: MetricPoint[]): number | null {
  const byBucket = new Map<string, number>();
  for (const p of decodePoints) {
    if (p.state === 'error' || p.synthetic === true) continue;
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
    byBucket.set(p.t, (byBucket.get(p.t) ?? 0) + p.value);
  }
  let best: number | null = null;
  for (const v of byBucket.values()) if (best === null || v > best) best = v;
  return best;
}

/** Formats a stat for display, falling back to EMPTY_STAT for missing data. */
export function formatStat(value: number | null, maximumFractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_STAT;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}
