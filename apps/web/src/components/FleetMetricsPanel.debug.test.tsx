import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
  LineChart: () => <div data-testid="line-chart" />,
  AreaChart: () => <div data-testid="line-chart" />,
  BarChart: () => <div data-testid="bar-chart" />,
  Line: () => <div data-testid="line" />,
  Area: () => <div data-testid="line" />,
  Bar: () => <div data-testid="bar" />,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
}));

interface SeriesResult {
  isLoading: boolean;
  isError: boolean;
  data: MetricPoint[] | undefined;
}

const state = vi.hoisted(() => ({
  byKey: new Map<string, unknown>(),
  scrape: null as null | { down: boolean; stalenessMs: number | null; lastSuccess: string | null },
}));

vi.mock('@/lib/queries', () => ({
  useSeries: (metric: string, range: string, group?: string): SeriesResult => {
    const key = `${metric}|${range}|${group ?? ''}`;
    return (state.byKey.get(key) as SeriesResult | undefined) ?? {
      isLoading: false,
      isError: false,
      data: undefined,
    };
  },
  useScrapeStatus: () => state.scrape,
}));

import { FleetMetricsPanel } from '@/components/FleetMetricsPanel';
import { stateToken } from '@/components/charts/stateTokens';
import type { MetricPoint } from '@/lib/types';

function setDeployments(points: MetricPoint[]) {
  state.byKey.set('decode_tps|1h|model_id', { isLoading: false, isError: false, data: points });
}

function setRequests(points: MetricPoint[]) {
  state.byKey.set('requests|1h|model', { isLoading: false, isError: false, data: points });
}

function setDebug(value: string | undefined) {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  if (value === undefined) delete env.VITE_DEBUG;
  else env.VITE_DEBUG = value;
}

const originalDebug = (import.meta.env as unknown as Record<string, string | undefined>).VITE_DEBUG;

beforeEach(() => {
  state.byKey.clear();
  state.scrape = null;
  setDebug(originalDebug);
  setRequests([
    { t: 't1', group: 'tools', value: 40 },
    { t: 't2', group: 'tools', value: 60 },
  ]);
  cleanup();
});

function deploymentCards(): HTMLElement[] {
  return screen.queryAllByTestId('deployment-card');
}

function cardTextFor(group: string): string | null {
  const hit = deploymentCards().find((el) => (el.textContent ?? '').includes(group));
  return hit ? hit.textContent ?? '' : null;
}

describe('C2 — the unassigned card is a debug-only affordance', () => {
  const points: MetricPoint[] = [
    { t: 't1', group: 'tools-moe', value: 50, in_inventory: true },
    { t: 't2', group: 'unassigned', value: 7, in_inventory: false },
  ];

  it('renders the unassigned card when debug is on', () => {
    setDebug('1');
    setDeployments(points);
    render(<FleetMetricsPanel />);
    expect(cardTextFor('unassigned')).not.toBeNull();
  });

  it('renders it by default when VITE_DEBUG is unset', () => {
    setDebug(undefined);
    setDeployments(points);
    render(<FleetMetricsPanel />);
    expect(cardTextFor('unassigned')).not.toBeNull();
  });

  it('hides the unassigned card when debug is off', () => {
    setDebug('0');
    setDeployments(points);
    render(<FleetMetricsPanel />);
    expect(cardTextFor('unassigned')).toBeNull();
    expect(cardTextFor('tools-moe')).not.toBeNull();
  });
});

describe('C3 — a zero-traffic backend still renders a card at 0', () => {
  it('does not hide an inventoried backend that produced no traffic', () => {
    setDebug('1');
    setDeployments([
      { t: 't1', group: 'busy-dep', value: 100, in_inventory: true, litellm_model_name: 'busy-model' },
      { t: 't2', group: 'busy-dep', value: 120, in_inventory: true, litellm_model_name: 'busy-model' },
      { t: 't1', group: 'idle-dep', value: 0, in_inventory: true, litellm_model_name: 'idle-model' },
      { t: 't2', group: 'idle-dep', value: 0, in_inventory: true, litellm_model_name: 'idle-model' },
    ]);
    render(<FleetMetricsPanel />);

    const idle = cardTextFor('idle-dep');
    expect(idle).not.toBeNull();
    expect(idle).toContain('0');
    expect(deploymentCards().length).toBe(2);
  });
});

describe('C4 — synthetic error points and the scrape banner', () => {
  const synthetic: MetricPoint[] = [
    { t: 't1', group: 'mid-a', value: 0, state: 'error', synthetic: true, in_inventory: true },
    { t: 't2', group: 'mid-a', value: 0, state: 'error', synthetic: true, in_inventory: true },
  ];

  it('paints the error state with the blue --error token', () => {
    expect(stateToken('error')).toBe('hsl(var(--error))');
    const css = readFileSync(resolve(__dirname, '..', 'index.css'), 'utf8');
    expect(css).toMatch(/--error:\s*203 92\.2% 50%/);
  });

  it('still renders the backend card when every point is synthetic filler', () => {
    setDebug('1');
    setDeployments(synthetic);
    render(<FleetMetricsPanel />);
    expect(cardTextFor('mid-a')).not.toBeNull();
  });

  it('shows the scrape banner with staleness text when the scrape is down', () => {
    setDebug('1');
    setDeployments(synthetic);
    state.scrape = { down: true, stalenessMs: 137000, lastSuccess: '2026-09-29T09:58:00.000Z' };
    render(<FleetMetricsPanel />);

    const banner = screen.getByTestId('scrape-banner');
    expect(banner.textContent).toContain('Scrape down');
    expect(banner.textContent).toContain('no scrape for 2m 17s');
    expect(banner.textContent).toContain('zero values below are filler, not measurements');
  });

  it('shows the stale wording when the scrape is late but not declared down', () => {
    setDebug('1');
    setDeployments(synthetic);
    state.scrape = { down: false, stalenessMs: 80000, lastSuccess: null };
    render(<FleetMetricsPanel />);
    expect(screen.getByTestId('scrape-banner').textContent).toContain('Scrape stale');
  });

  it('shows no banner while the scrape is fresh', () => {
    setDebug('1');
    setDeployments(synthetic);
    state.scrape = { down: false, stalenessMs: 5000, lastSuccess: null };
    render(<FleetMetricsPanel />);
    expect(screen.queryByTestId('scrape-banner')).toBeNull();
  });
});
