import { describe, expect, it } from 'vitest';
import {
  EMPTY_STAT,
  EXCLUDED_RPM_STATES,
  combinedObservedTokenRate,
  formatStat,
  groupPointsByGroup,
  meanExcludingStates,
  meanOf,
  meanOfActive,
  numericValues,
} from '@/lib/stats';
import type { MetricPoint } from '@/lib/types';

const T = '2026-01-01T00:00:00.000Z';

describe('numericValues', () => {
  it('strips null values and keeps only numbers', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: 1 },
      { t: T, group: 'a', value: null },
      { t: T, group: 'a', value: 2 },
    ];
    expect(numericValues(points)).toEqual([1, 2]);
  });
});

describe('meanOf', () => {
  it('averages the numeric points', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: 10 },
      { t: T, group: 'a', value: 20 },
      { t: T, group: 'a', value: 30 },
    ];
    expect(meanOf(points)).toBe(20);
  });

  it('ignores null values instead of counting them as zero', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: 10 },
      { t: T, group: 'a', value: null },
      { t: T, group: 'a', value: 30 },
    ];
    expect(meanOf(points)).toBe(20);
  });

  it('returns null for an empty series so the UI shows "—" instead of 0', () => {
    expect(meanOf([])).toBeNull();
  });

  it('returns null when every value in the series is null', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: null },
      { t: T, group: 'a', value: null },
    ];
    expect(meanOf(points)).toBeNull();
  });
});

describe('EXCLUDED_RPM_STATES', () => {
  it('excludes idle and error buckets only', () => {
    expect(EXCLUDED_RPM_STATES.has('idle')).toBe(true);
    expect(EXCLUDED_RPM_STATES.has('error')).toBe(true);
    expect(EXCLUDED_RPM_STATES.has('healthy')).toBe(false);
  });
});

describe('meanExcludingStates', () => {
  it('drops idle and error buckets using the default excluded set', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: 10, state: 'healthy' },
      { t: T, group: 'a', value: 0, state: 'idle' },
      { t: T, group: 'a', value: 25, state: 'error' },
      { t: T, group: 'a', value: 30, state: 'healthy' },
    ];
    expect(meanExcludingStates(points)).toBe(20);
  });

  it('keeps points that carry no state key', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: 10 },
      { t: T, group: 'a', value: 30, state: 'healthy' },
    ];
    expect(meanExcludingStates(points)).toBe(20);
  });

  it('returns null when the whole series is idle/error', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: 0, state: 'idle' },
      { t: T, group: 'a', value: 25, state: 'error' },
    ];
    expect(meanExcludingStates(points)).toBeNull();
  });

  it('lets an explicit excluded set override the default', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: 10, state: 'healthy' },
      { t: T, group: 'a', value: 0, state: 'idle' },
      { t: T, group: 'a', value: 40, state: 'prefill' },
    ];
    // Default would give (10 + 40) / 2 = 25; excluding prefill instead gives (10 + 0) / 2 = 5.
    expect(meanExcludingStates(points, new Set(['prefill']))).toBe(5);
  });

  it('also drops null values while excluding states', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'a', value: null, state: 'healthy' },
      { t: T, group: 'a', value: 20, state: 'healthy' },
    ];
    expect(meanExcludingStates(points)).toBe(20);
  });
});

describe('groupPointsByGroup', () => {
  it('buckets points into one entry per group', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'alpha', value: 1 },
      { t: T, group: 'beta', value: 2 },
      { t: T, group: 'alpha', value: 3 },
    ];
    const grouped = groupPointsByGroup(points);
    expect(grouped.size).toBe(2);
    expect(grouped.get('alpha')).toHaveLength(2);
    expect(grouped.get('beta')).toHaveLength(1);
    expect(grouped.get('alpha')?.map((p) => p.value)).toEqual([1, 3]);
  });
});

describe('combinedObservedTokenRate', () => {
  it('sums the per-deployment means', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'dep-a', value: 10 },
      { t: T, group: 'dep-a', value: 10 },
      { t: T, group: 'dep-b', value: 20 },
      { t: T, group: 'dep-b', value: 40 },
    ];
    expect(combinedObservedTokenRate(points)).toBe(40);
  });

  it('ignores a group whose points are all null', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'dep-a', value: 10 },
      { t: T, group: 'dep-b', value: 30 },
      { t: T, group: 'dep-c', value: null },
      { t: T, group: 'dep-c', value: null },
    ];
    expect(combinedObservedTokenRate(points)).toBe(40);
  });

  it('returns null for an empty series', () => {
    expect(combinedObservedTokenRate([])).toBeNull();
  });

  it('averages each deployment over its active buckets only (idle zeros excluded)', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'dep-a', value: 40, state: 'healthy' },
      { t: T, group: 'dep-a', value: 0, state: 'idle' },
      { t: T, group: 'dep-a', value: 0, state: 'idle' },
      { t: T, group: 'dep-b', value: 0, state: 'idle' },
    ];
    expect(combinedObservedTokenRate(points)).toBe(40);
  });
});

describe('meanOfActive', () => {
  it('ignores idle zeros, error buckets and scrape-down filler', () => {
    const points: MetricPoint[] = [
      { t: T, group: 'g', value: 30, state: 'healthy' },
      { t: T, group: 'g', value: 50, state: 'healthy' },
      { t: T, group: 'g', value: 0, state: 'idle' },
      { t: T, group: 'g', value: 0, state: 'prefill' },
      { t: T, group: 'g', value: 25, state: 'error' },
      { t: T, group: 'g', value: 0, state: 'error', synthetic: true },
      { t: T, group: 'g', value: null },
    ];
    expect(meanOfActive(points)).toBe(40);
  });

  it('is null when nothing decoded in the window', () => {
    expect(meanOfActive([{ t: T, group: 'g', value: 0, state: 'idle' }])).toBeNull();
  });
});

describe('formatStat', () => {
  it('renders the empty marker for null', () => {
    expect(formatStat(null)).toBe(EMPTY_STAT);
    expect(EMPTY_STAT).toBe('\u2014');
  });

  it('renders zero as a real value, not the empty marker', () => {
    expect(formatStat(0)).toBe('0');
  });

  it('rounds to the requested fraction digits and groups thousands', () => {
    expect(formatStat(1234.567, 0)).toBe('1,235');
    expect(formatStat(12.34)).toBe('12.3');
  });

  it('renders non-finite values as the empty marker', () => {
    expect(formatStat(Number.NaN)).toBe(EMPTY_STAT);
    expect(formatStat(Number.POSITIVE_INFINITY)).toBe(EMPTY_STAT);
  });
});

describe('regression — idle-window omission', () => {
  it('does not drag the mean toward zero when idle buckets are omitted as gaps', () => {
    // The API already INNER JOINs idle buckets out of decode_tps/input_tps, so the
    // series arrives with gaps. Re-adding those gaps as zeros would halve the rate.
    const decodeSeries: MetricPoint[] = [
      { t: '2026-01-01T00:00:00.000Z', group: 'dep-a', value: 12 },
      { t: '2026-01-01T00:01:00.000Z', group: 'dep-a', value: null },
      { t: '2026-01-01T00:02:00.000Z', group: 'dep-a', value: 18 },
    ];
    expect(meanExcludingStates(decodeSeries)).toBe(15);
    expect(meanOf(decodeSeries)).toBe(15);
  });
});
