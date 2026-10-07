import { afterEach, describe, expect, it } from 'vitest';

import { isDebugEnabled, UNASSIGNED_GROUP } from '@/lib/debug';

// C1: isDebugEnabled is the app's only reader of VITE_DEBUG and it is ON by
// default, so the debug-only "unassigned" card ships visible until switched off.

function setDebug(value: string | undefined) {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  if (value === undefined) {
    delete env.VITE_DEBUG;
  } else {
    env.VITE_DEBUG = value;
  }
}

const original = (import.meta.env as unknown as Record<string, string | undefined>).VITE_DEBUG;

afterEach(() => {
  setDebug(original);
});

describe('isDebugEnabled', () => {
  it('is on for "1"', () => {
    setDebug('1');
    expect(isDebugEnabled()).toBe(true);
  });

  it('is on for "true"', () => {
    setDebug('true');
    expect(isDebugEnabled()).toBe(true);
  });

  it('is on when VITE_DEBUG is unset', () => {
    setDebug(undefined);
    expect(isDebugEnabled()).toBe(true);
  });

  it('is on for an empty value', () => {
    setDebug('');
    expect(isDebugEnabled()).toBe(true);
  });

  it('is off for "0"', () => {
    setDebug('0');
    expect(isDebugEnabled()).toBe(false);
  });

  it('is off for other values', () => {
    for (const raw of ['false', 'off', 'no', '0 ', '2', 'yes', 'debug']) {
      setDebug(raw);
      expect(isDebugEnabled()).toBe(false);
    }
  });

  it('trims and lowercases before deciding', () => {
    setDebug('  TRUE ');
    expect(isDebugEnabled()).toBe(true);
    setDebug(' False ');
    expect(isDebugEnabled()).toBe(false);
  });
});

describe('UNASSIGNED_GROUP', () => {
  it('matches the literal the API emits', () => {
    expect(UNASSIGNED_GROUP).toBe('unassigned');
  });
});
