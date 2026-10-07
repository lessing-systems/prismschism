import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VendorCredit } from '@/components/VendorCredit';
import { isCreditEnabled } from '@/lib/credit';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('isCreditEnabled', () => {
  it('is on by default (unset or empty)', () => {
    vi.stubEnv('VITE_SHOW_CREDIT', '');
    expect(isCreditEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'OFF', ' no '])('is off for %j', (v) => {
    vi.stubEnv('VITE_SHOW_CREDIT', v);
    expect(isCreditEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'yes'])('stays on for %j', (v) => {
    vi.stubEnv('VITE_SHOW_CREDIT', v);
    expect(isCreditEnabled()).toBe(true);
  });
});

describe('VendorCredit', () => {
  it('links to lessing.systems in a new tab', () => {
    render(<VendorCredit />);
    const link = screen.getByTestId('vendor-credit');
    expect(link.getAttribute('href')).toBe('https://lessing.systems');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('lessing.systems');
  });

  it('renders nothing (not even the divider) when disabled', () => {
    vi.stubEnv('VITE_SHOW_CREDIT', 'false');
    const { container } = render(<VendorCredit />);
    expect(container.innerHTML).toBe('');
  });
});
