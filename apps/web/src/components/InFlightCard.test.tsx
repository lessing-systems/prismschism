// Contract tests for the InFlightCard: gauge value, null-gauge placeholder
// (missing table / no sample yet), and the distinct-sessions byModel rows.
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
    ...overrides,
  };
}

beforeEach(() => {
  state.inflight = undefined;
  state.isError = false;
  cleanup();
});

describe('InFlightCard', () => {
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
    // Each row carries its distinct count next to the model id.
    const rows = screen.getByRole('list').querySelectorAll('li');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('12');
    expect(rows[1].textContent).toContain('8');
  });

  it('shows the error state when the query fails', () => {
    state.isError = true;
    render(<InFlightCard />);
    expect(screen.getByTestId('in-flight-card').textContent).toContain('Failed to load');
  });
});
