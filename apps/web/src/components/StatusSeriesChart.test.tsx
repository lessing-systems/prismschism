// Contract tests for the REAL chart components (B2/B3 work):
//   apps/web/src/components/charts/MetricLineChart.tsx  (named export)
//   apps/web/src/components/charts/StateBarChart.tsx    (named export)
//
// Binding Recharts v3 constraints under test:
//   * gaps   -> connectNulls={false}   (true coerces null->0 and erases the gap)
//   * idle   -> value 0, DISTINCT from a null gap
//   * error  -> non-null ERROR_SENTINEL + <Cell> fill (a null Bar renders NOTHING in v3)
//   * series -> isAnimationActive={false} (mandatory at ~50-series scale)
//   * dot/cell color derived per-point from state via the stateToken helper.
//
// We mock `recharts` (not @testing-library queries) because the real
// ResponsiveContainer measures via ResizeObserver — absent in jsdom — which
// collapses the chart to 0x0 and renders no inner elements. Mocking lets us
// assert the exact props the components wire onto their Recharts primitives.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

// --- recharts mock: capture props so the contract is directly assertable ----
interface Captured {
  lineChart?: Record<string, unknown>;
  barChart?: Record<string, unknown>;
  line?: Record<string, unknown>;
  bar?: Record<string, unknown>;
  yAxis?: Record<string, unknown>;
  cells: Array<{ fill?: string }>;
}

const captured = vi.hoisted(() => ({ props: { cells: [] } as unknown as Captured }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
  LineChart: (p: { data?: unknown[]; children?: ReactNode }) => {
    captured.props.lineChart = p as Record<string, unknown>;
    return <div data-testid="line-chart">{p.children}</div>;
  },
  // MetricLineChart renders an AreaChart/Area; they land in the same captured
  // slots as LineChart/Line so the series contract stays directly assertable.
  AreaChart: (p: { data?: unknown[]; children?: ReactNode }) => {
    captured.props.lineChart = p as Record<string, unknown>;
    return <div data-testid="line-chart">{p.children}</div>;
  },
  Area: (p: Record<string, unknown>) => {
    captured.props.line = p;
    return <div data-testid="line" />;
  },
  BarChart: (p: { data?: unknown[]; children?: ReactNode }) => {
    captured.props.barChart = p as Record<string, unknown>;
    return <div data-testid="bar-chart">{p.children}</div>;
  },
  Line: (p: Record<string, unknown>) => {
    captured.props.line = p;
    return <div data-testid="line" />;
  },
  Bar: (p: { children?: ReactNode }) => {
    captured.props.bar = p as Record<string, unknown>;
    return <div data-testid="bar">{p.children}</div>;
  },
  Cell: (p: { fill?: string }) => {
    captured.props.cells.push(p);
    return null;
  },
  XAxis: () => null,
  YAxis: (p: Record<string, unknown>) => {
    captured.props.yAxis = p;
    return null;
  },
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

import { MetricLineChart } from '@/components/charts/MetricLineChart';
import { StateBarChart } from '@/components/charts/StateBarChart';
import { stateToken } from '@/components/charts/stateTokens';
import { ERROR_SENTINEL, isErrorSentinel, type MetricPoint, type MetricPointState } from '@/lib/types';
import { seriesFor } from '@/mocks/data';

type DotRenderFn = (props: { cx?: number; cy?: number; payload?: MetricPoint }) => ReactElement | null;

const POINT_STATES: MetricPointState[] = ['healthy', 'prefill', 'idle', 'error'];

function pt(over: Partial<MetricPoint> & { t?: string } = {}): MetricPoint {
  return { t: '2026-09-28T00:00:00.000Z', group: 'g1', value: 10, state: 'healthy', ...over };
}

beforeEach(() => {
  captured.props = { cells: [] };
  cleanup();
});

describe('MetricLineChart — Recharts v3 binding constraints', () => {
  it('wires the Line with connectNulls={false} (gap preservation)', () => {
    render(
      <MetricLineChart
        points={[
          pt({ t: 't1', value: 5 }),
          pt({ t: 't2', value: null, state: undefined }),
          pt({ t: 't3', value: 7 }),
        ]}
      />
    );
    const line = captured.props.line;
    expect(line, 'expected a Line series to render').toBeDefined();
    expect(line!.connectNulls).toBe(false);
  });

  it('renders the Line with isAnimationActive={false} (mandatory at 50-series scale)', () => {
    render(<MetricLineChart points={[pt()]} />);
    expect(captured.props.line!.isAnimationActive).toBe(false);
  });

  it('passes raw points through without coercing null->0 (idle=0 stays distinct from gap=null)', () => {
    const points: MetricPoint[] = [
      pt({ t: 't1', value: 0, state: 'idle' }), // idle -> zero, NOT a gap
      pt({ t: 't2', value: null, state: undefined }), // missing -> gap
      pt({ t: 't3', value: 7, state: 'healthy' }), // active
    ];
    render(<MetricLineChart points={points} />);
    const data = captured.props.lineChart!.data as MetricPoint[];
    expect(data.map((d) => d.value)).toEqual([0, null, 7]);
  });

  it('dot marks only FLAGGED points (error or synthetic), filled via stateToken()', () => {
    render(<MetricLineChart points={[pt()]} />);
    const dot = captured.props.line!.dot as DotRenderFn;
    expect(typeof dot).toBe('function');
    for (const state of POINT_STATES) {
      const el = dot({ cx: 1, cy: 1, payload: pt({ value: 10, state }) });
      if (state === 'error') {
        expect(el, 'expected a dot for state=error').not.toBeNull();
        expect((el!.props as { fill?: string }).fill).toBe(stateToken('error'));
      } else {
        // State over time is carried by the state strip, not per-point dots.
        expect(el, `expected no dot for state=${state}`).toBeNull();
      }
    }
    const filler = dot({ cx: 1, cy: 1, payload: pt({ value: 0, state: 'error', synthetic: true }) });
    expect(filler).not.toBeNull();
    expect((filler!.props as { fill?: string }).fill).toBe(stateToken('error'));
  });

  it('state strip paints each run of buckets with its state token; gaps stay transparent', () => {
    const { container } = render(
      <MetricLineChart
        points={[
          pt({ t: 't1', value: 0, state: 'idle' }),
          pt({ t: 't2', value: 0, state: 'idle' }),
          pt({ t: 't3', value: null, state: undefined }),
          pt({ t: 't4', value: 9, state: 'healthy' }),
          pt({ t: 't5', value: 25, state: 'error' }),
        ]}
      />
    );
    const strip = container.querySelector('[data-testid="state-strip"]');
    expect(strip).not.toBeNull();
    const segs = Array.from(strip!.children) as HTMLElement[];
    expect(segs.map((s) => s.style.flexGrow)).toEqual(['2', '1', '1', '1']);
    expect(segs.map((s) => s.style.backgroundColor)).toEqual([
      stateToken('idle'),
      'transparent',
      stateToken('healthy'),
      stateToken('error'),
    ]);
  });

  it('keeps the frozen --chart-1 stroke for an unpositioned series', () => {
    render(<MetricLineChart points={[pt({ value: 10, state: undefined })]} />);
    expect(captured.props.line!.stroke).toBe('hsl(var(--chart-1))');
    expect(stateToken(undefined)).toBe('hsl(var(--chart-1))');
  });

  it('dot renders NOTHING for a null (gap) point — no stray mark bridging the gap', () => {
    render(<MetricLineChart points={[pt({ value: null, state: undefined })]} />);
    const dot = captured.props.line!.dot as DotRenderFn;
    expect(dot({ cx: 1, cy: 1, payload: pt({ value: null, state: undefined }) })).toBeNull();
  });
});

describe('StateBarChart — Recharts v3 binding constraints', () => {
  it('renders the Bar with isAnimationActive={false}', () => {
    render(<StateBarChart points={[pt()]} />);
    expect(captured.props.bar!.isAnimationActive).toBe(false);
  });

  it('paints each cell with a color derived from the point state via stateToken()', () => {
    render(
      <StateBarChart
        points={POINT_STATES.map((s, i) => pt({ t: `t${i}`, value: 10, state: s }))}
      />
    );
    expect(captured.props.cells.length).toBe(POINT_STATES.length);
    POINT_STATES.forEach((state, i) => {
      expect(captured.props.cells[i].fill).toBe(stateToken(state));
    });
  });

  it('paints sentinel points blue via isErrorSentinel even when state is missing (never a null bar)', () => {
    render(
      <StateBarChart
        points={[
          pt({ t: 't1', value: ERROR_SENTINEL, state: 'error' }),
          pt({ t: 't2', value: ERROR_SENTINEL, state: undefined }), // sentinel w/o state
          pt({ t: 't3', value: 100, state: 'healthy' }),
        ]}
      />
    );
    const errorFill = stateToken('error');
    expect(captured.props.cells[0].fill).toBe(errorFill);
    expect(captured.props.cells[1].fill).toBe(errorFill); // caught by isErrorSentinel()
    expect(captured.props.cells[2].fill).toBe(stateToken('healthy'));
    // Sanity: the sentinel is a visible non-null positive value (a null Bar draws nothing).
    expect(isErrorSentinel(ERROR_SENTINEL)).toBe(true);
    expect(ERROR_SENTINEL).toBeGreaterThan(0);
  });

  it('passes raw points through as chart data without coercing null->0', () => {
    const points: MetricPoint[] = [
      pt({ t: 't1', value: 0, state: 'idle' }),
      pt({ t: 't2', value: null, state: undefined }),
      pt({ t: 't3', value: 7, state: 'healthy' }),
    ];
    render(<StateBarChart points={points} />);
    const data = captured.props.barChart!.data as MetricPoint[];
    expect(data.map((d) => d.value)).toEqual([0, null, 7]);
  });
});

describe('mock generator (mocks/data.ts) — guaranteed segments per window', () => {
  // Count the longest consecutive run satisfying pred across the point list.
  function longestRun(points: MetricPoint[], pred: (p: MetricPoint) => boolean): number {
    let best = 0;
    let cur = 0;
    for (const p of points) {
      cur = pred(p) ? cur + 1 : 0;
      if (cur > best) best = cur;
    }
    return best;
  }

  for (const range of ['1h', '24h', '7d'] as const) {
    for (const group of ['model', 'api_provider'] as const) {
      it(`${range}/${group}: contains >=1 zero-run(3), >=1 null-run(3), >=1 sentinel-run(2)`, () => {
        const points = seriesFor('requests', range, group);
        expect(longestRun(points, (p) => p.value === 0), 'zero-run (idle)').toBeGreaterThanOrEqual(3);
        expect(longestRun(points, (p) => p.value === null), 'null-run (gap)').toBeGreaterThanOrEqual(3);
        expect(longestRun(points, (p) => isErrorSentinel(p.value)), 'sentinel-run (error)').toBeGreaterThanOrEqual(2);
      });

      it(`${range}/${group}: sentinel<=>error invariant (collision guard holds)`, () => {
        const points = seriesFor('requests', range, group);
        for (const p of points) {
          if (isErrorSentinel(p.value)) {
            expect(p.state, `sentinel value with state=${String(p.state)} at ${p.t}`).toBe('error');
          }
        }
      });
    }
  }
});

describe("chart axis labels — HH:mm ticks, sliding DD/MM date row, Y unit label", () => {
  // The date row is real DOM: it is a sibling AFTER the mocked
  // ResponsiveContainer, so it renders even though the SVG internals do not.
  function dateRow(container: HTMLElement): { left: string; right: string } | null {
    const row = container.querySelector('[data-testid="chart-date-labels"]');
    if (!row) return null;
    const spans = Array.from(row.querySelectorAll('span'));
    expect(spans.length).toBe(2);
    return { left: spans[0].textContent ?? '', right: spans[1].textContent ?? '' };
  }

  const spansMidnight = [
    pt({ t: '2026-09-30T23:45:00.000Z' }),
    pt({ t: '2026-10-01T00:10:00.000Z' }),
  ];
  const singleDate = [
    pt({ t: '2026-09-30T23:10:00.000Z' }),
    pt({ t: '2026-09-30T23:45:00.000Z' }),
  ];

  it('MetricLineChart: straddling midnight puts the older date left, newer date right', () => {
    const { container } = render(<MetricLineChart points={spansMidnight} />);
    expect(container.querySelector('[data-testid="chart-date-labels"]')).not.toBeNull();
    expect(dateRow(container)).toEqual({ left: '30/09', right: '01/10' });
  });

  it('MetricLineChart: a window on one date shows that date on the right only', () => {
    const { container } = render(<MetricLineChart points={singleDate} />);
    expect(container.querySelector('[data-testid="chart-date-labels"]')).not.toBeNull();
    expect(dateRow(container)).toEqual({ left: '', right: '30/09' });
  });

  it('StateBarChart: straddling midnight puts the older date left, newer date right', () => {
    const { container } = render(<StateBarChart points={spansMidnight} />);
    expect(container.querySelector('[data-testid="chart-date-labels"]')).not.toBeNull();
    expect(dateRow(container)).toEqual({ left: '30/09', right: '01/10' });
  });

  it('StateBarChart: a window on one date shows that date on the right only', () => {
    const { container } = render(<StateBarChart points={singleDate} />);
    expect(container.querySelector('[data-testid="chart-date-labels"]')).not.toBeNull();
    expect(dateRow(container)).toEqual({ left: '', right: '30/09' });
  });

  it('MetricLineChart passes the series unit through to the YAxis label', () => {
    render(<MetricLineChart points={[pt({ unit: 'token/s' })]} />);
    const label = captured.props.yAxis!.label as { value?: string };
    expect(label.value).toBe('token/s');
  });

  it('StateBarChart passes the series unit through to the YAxis label', () => {
    render(<StateBarChart points={[pt({ unit: 'token/s' })]} />);
    const label = captured.props.yAxis!.label as { value?: string };
    expect(label.value).toBe('token/s');
  });

  it('renders NO YAxis label when no point carries a unit (never invents one)', () => {
    render(<MetricLineChart points={[pt()]} />);
    expect(captured.props.yAxis!.label).toBeUndefined();
    render(<StateBarChart points={[pt()]} />);
    expect(captured.props.yAxis!.label).toBeUndefined();
  });

  it('renders no date row at all for an empty series', () => {
    const line = render(<MetricLineChart points={[]} />);
    expect(line.container.querySelector('[data-testid="chart-date-labels"]')).toBeNull();
    const bar = render(<StateBarChart points={[]} />);
    expect(bar.container.querySelector('[data-testid="chart-date-labels"]')).toBeNull();
  });
});
