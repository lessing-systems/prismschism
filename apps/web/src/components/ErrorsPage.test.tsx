// Contract tests for the ErrorsPage: API order preserved (latest first),
// detail sentence on the tooltip AND the visible second line, severity dot
// classes per severity, empty/loading/failure states, and count badges.
// Harness style follows InFlightCard.test.tsx — mock the hook module,
// render, assert on DOM text.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ErrorEvent, ErrorsResponse } from '@/lib/api';

const state = vi.hoisted(() => ({
  errors: undefined as ErrorsResponse | undefined,
  isError: false,
  isLoading: false,
}));

vi.mock('@/lib/queries', () => ({
  useErrors: () => ({
    isLoading: state.isLoading,
    isError: state.isError,
    data: state.errors,
  }),
}));

import { ErrorsPage } from '@/components/ErrorsPage';

function event(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    ts: '2026-10-11T09:00:00.000Z',
    kind: 'cooldown',
    subject: 'glm',
    severity: 'error',
    count: 3,
    detail: 'Upstream returned HTTP 500 for 40s; cooldown engaged.',
    ...overrides,
  };
}

beforeEach(() => {
  state.errors = undefined;
  state.isError = false;
  state.isLoading = false;
  cleanup();
});

describe('ErrorsPage', () => {
  it('renders rows in API order (latest first — order preserved, not re-sorted)', () => {
    state.errors = {
      errors: [
        event({ ts: '2026-10-11T09:05:00.000Z', subject: 'kimi', kind: 'state-error' }),
        event({ ts: '2026-10-11T08:00:00.000Z', subject: 'glm', kind: 'cooldown' }),
      ],
    };
    render(<ErrorsPage />);
    const subjects = screen.getAllByTestId('errors-list')[0].querySelectorAll('li');
    expect(subjects.length).toBe(2);
    expect(subjects[0].textContent).toContain('kimi');
    expect(subjects[1].textContent).toContain('glm');
  });

  it('carries the detail sentence on both the tooltip and the visible second line', () => {
    const detail = 'Upstream returned HTTP 500 for 40s; cooldown engaged.';
    state.errors = { errors: [event({ detail })] };
    render(<ErrorsPage />);
    // Visible second line AND the tooltip — one occurrence each.
    expect(screen.getAllByText(detail).length).toBe(2);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe(detail);
    expect(tooltip.closest('[title]')?.getAttribute('title')).toBe(detail);
  });

  it('renders severity dot classes per severity (destructive vs amber token)', () => {
    state.errors = {
      errors: [
        event({ severity: 'error' }),
        event({ severity: 'warning', kind: 'lane-wait' }),
      ],
    };
    render(<ErrorsPage />);
    const dots = screen.getAllByTestId('severity-dot');
    expect(dots[0].className).toContain('bg-destructive');
    expect(dots[0].className).not.toContain('bg-state-prefill');
    expect(dots[1].className).toContain('bg-state-prefill');
    expect(dots[1].className).not.toContain('bg-destructive');
  });

  it('renders short human kind labels', () => {
    state.errors = {
      errors: [
        event({ kind: 'cooldown' }),
        event({ kind: 'state-error' }),
        event({ kind: 'lane-wait', severity: 'warning' }),
        event({ kind: 'scrape-fail', severity: 'warning' }),
      ],
    };
    render(<ErrorsPage />);
    expect(screen.getByText('Upstream 500')).toBeTruthy();
    expect(screen.getByText('Deployment unhealthy')).toBeTruthy();
    expect(screen.getByText('Lanes saturated')).toBeTruthy();
    expect(screen.getByText('Metrics scrape failed')).toBeTruthy();
  });

  it('renders count badges', () => {
    state.errors = { errors: [event({ count: 12 })] };
    render(<ErrorsPage />);
    expect(screen.getByText('×12')).toBeTruthy();
  });

  it('renders the empty state when there are no errors in the window', () => {
    state.errors = { errors: [] };
    render(<ErrorsPage />);
    expect(screen.getByText('No errors in the last 24h.')).toBeTruthy();
  });

  it('renders a loading skeleton while the query is pending', () => {
    state.isLoading = true;
    const { container } = render(<ErrorsPage />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByTestId('errors-list')).toBeNull();
  });

  it('renders the InlineError-style destructive block when the query fails', () => {
    state.isError = true;
    render(<ErrorsPage />);
    expect(screen.getByText('Failed to load errors').className).toContain('text-destructive');
  });

  it('renders the header with subtitle and window note', () => {
    render(<ErrorsPage />);
    expect(screen.getByText('Errors')).toBeTruthy();
    expect(screen.getByText(/docs\/error-states\.md/)).toBeTruthy();
    expect(screen.getByText('last 24h')).toBeTruthy();
  });
});
