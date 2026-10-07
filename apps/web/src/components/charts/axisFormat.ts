// Pure axis-label helpers shared by the chart components. No React, no recharts.
//
// Why UTC string slicing instead of Date/timezone math: point `t` values are
// always UTC ISO strings from the API (e.g. "2026-09-30T09:55:00.000Z"). Slicing
// the UTC fields keeps labels deterministic in every viewer timezone (a local
// Date would silently shift ticks and could disagree with the data) and matches
// the slicing-based behaviour this module replaces.
//
// Sliding two-date rule: X ticks carry HH:mm only; dates live in a separate row
// BELOW the axis and there are never more than two of them:
//   * the window spans a midnight boundary (first date != last date) -> the older
//     date sits at the left end and the newer date at the right end; for a 7d
//     window (many midnights) that is simply the first and last date of the
//     window.
//   * the window sits on a single date -> that date alone, at the right end.
// Dates are European DD/MM. Never per-tick dates.

/** X tick label: "HH:mm" from a UTC ISO string; anything else is stringified. */
export function formatTick(value: unknown): string {
  if (typeof value === "string" && value.length >= 16) return value.slice(11, 16);
  return String(value);
}

/** Date label: European "DD/MM" from a UTC ISO string; else stringified. */
export function formatDateLabel(value: unknown): string {
  if (typeof value === "string" && value.length >= 10) {
    return value.slice(8, 10) + "/" + value.slice(5, 7);
  }
  return String(value);
}

/** DD/MM from a UTC ISO date-time string (slice form used by the sort fallback). */
function dayMonth(key: string): string {
  return key.slice(8, 10) + "/" + key.slice(5, 7);
}

/**
 * The two (or one) dates to show under the X axis for a window, applying the
 * sliding rule documented above. Returns null for an empty window so the caller
 * renders no date row at all.
 */
export function computeDateLabels(
  points: readonly { t: string }[]
): { left: string | null; right: string } | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => {
    const delta = Date.parse(a.t) - Date.parse(b.t);
    // Non-ISO keys (mock fixtures such as "t1") fall back to string order.
    return Number.isNaN(delta) ? String(a.t).localeCompare(String(b.t)) : delta;
  });
  const first = sorted[0].t;
  const last = sorted[sorted.length - 1].t;
  if (first.slice(0, 10) === last.slice(0, 10)) return { left: null, right: dayMonth(first) };
  return { left: dayMonth(first), right: dayMonth(last) };
}

/**
 * The Y-axis unit for a series: the first point carrying a defined non-empty
 * `unit` wins. Undefined when no point declares one, so the caller renders NO
 * label rather than inventing a unit.
 */
export function seriesUnit(points: readonly { unit?: string }[]): string | undefined {
  for (const p of points) {
    if (typeof p.unit === "string" && p.unit.length > 0) return p.unit;
  }
  return undefined;
}
