// Contract tests for the InFlightCard: gauge value, null-gauge placeholder
// (missing table / no sample yet), distinct-sessions byModel rows, and the
// backend lanes (running/max, waiting highlight, pre-migration absence).
// Harness style follows FleetMetricsPanel.debug.test.tsx — mock the hook
// module, render, assert on DOM text.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { InflightResponse } from '@/lib/api';

const state = vi.hoisted(() => ({
  inflight: undefined as InflightResponse | undefined,
  isError: false,
}));

vi.mock('@/lib/queries', () => ({
  useInflight: () => ({
    isLoading: false,
    isError: state.isError,
    data: state.inflight,
  }),
}));

import { InFlightCard } from '@/components/InFlightCard';

function sample(overrides: Partial<InflightResponse> = {}): InflightResponse {
  return {
    inflight: { ts: '2026-10-11T09:00:00.000Z', value: 7, unit: 'requests' },
    sessions: {
      windowMinutes: 15,
      distinctTotal: 23,
      byModel: [
        { modelId: 'glm-4.6', distinct: 12 },
        { modelId: 'kimi-k2', distinct: 8 },
      ],
    },
    backends: [
      { backend: 'glm', running: 4, waiting: 0, max: 8 },
      { backend: 'kimi', running: 1, waiting: 0, max: 4 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  state.inflight = undefined;
  state.isError = false;
  cleanup();
});

describe('InFlightCard', () => {
  it('renders the flat full-width grid container (gauge | sessions | backends)', () => {
    state.inflight = sample();
    render(<InFlightCard />);
    const grid = screen.getByTestId('in-flight-grid');
    expect(grid.className).toContain('grid');
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,2fr)]');
  });

  it('renders the current gauge value and unit', () => {
    state.inflight = sample();
    render(<InFlightCard />);
    const card = screen.getByTestId('in-flight-card');
    expect(card.textContent).toContain('7');
    expect(card.textContent).toContain('requests');
    expect(card.textContent).toContain('sampled');
  });

  it('renders the em-dash placeholder when the gauge has no sample (missing table or no data yet)', () => {
    state.inflight = sample({
      inflight: { ts: null, value: null, unit: 'requests' },
    });
    render(<InFlightCard />);
    const card = screen.getByTestId('in-flight-card');
    expect(card.textContent).toContain('\u2014');
    expect(card.textContent).toContain('no sample yet');
  });

  it('renders the distinct total and every byModel row', () => {
    state.inflight = sample();
    render(<InFlightCard />);
    const card = screen.getByTestId('in-flight-card');
    expect(card.textContent).toContain('distinct sessions (15m)');
    expect(screen.getByText('glm-4.6').textContent).toBe('glm-4.6');
    expect(screen.getByText('kimi-k2').textContent).toBe('kimi-k2');
    // Each row carries its distinct count next to the model id. (First list:
    // the second one is the backends section.)
    const rows = screen.getAllByRole('list')[0].querySelectorAll('li');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('12');
    expect(rows[1].textContent).toContain('8');
  });

  it('shows the error state when the query fails', () => {
    state.isError = true;
    render(<InFlightCard />);
    expect(screen.getByTestId('in-flight-card').textContent).toContain('Failed to load');
  });

  it('renders each backend lane as running/max and highlights waiting > 0 in the destructive style', () => {
    state.inflight = sample({
      backends: [{ backend: 'glm', running: 4, waiting: 2, max: 8 }],
    });
    render(<InFlightCard />);
    expect(screen.getByTestId('backends-section').textContent).toContain('4/8');
    const waiting = screen.getByText('+2 waiting');
    expect(waiting.className).toContain('text-destructive');
  });

  it('renders a muted "0 waiting" all-clear when the waiting count is zero', () => {
    state.inflight = sample({
      backends: [{ backend: 'glm', running: 4, waiting: 0, max: 8 }],
    });
    render(<InFlightCard />);
    const waiting = screen.getByText('0 waiting');
    expect(waiting.className).toContain('text-muted-foreground');
  });

  it('hides the backends section entirely when backends is empty (pre-migration)', () => {
    state.inflight = sample({ backends: [] });
    render(<InFlightCard />);
    expect(screen.queryByTestId('backends-section')).toBeNull();
  });

  it('renders the em-dash placeholder for lanes when running/max are null', () => {
    state.inflight = sample({
      backends: [{ backend: 'glm', running: null, waiting: null, max: null }],
    });
    render(<InFlightCard />);
    const section = screen.getByTestId('backends-section');
    expect(section.textContent).toContain('glm');
    expect(section.textContent).toContain('\u2014');
    expect(section.textContent).not.toContain('waiting');
  });
});
