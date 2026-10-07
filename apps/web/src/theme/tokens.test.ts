// TDD contract — token mapping (traffic-light).
//
// BINDING mapping:
//   state-idle  -> coral-red #f0685f  (healthy-but-quiet; red is NEVER failure)
//   state-error -> accent-blue #0a9bf5 (error binds to the accent)
// healthy/streaming = green, prefill = orange, disabled = neutral grey.
//
// There is no TS token object — the palette lives as HSL custom properties in
// index.css under one [data-theme="<scheme>"] block per scheme (see schemes.ts
// for the 5 scheme ids). This test parses those live values, converts HSL->hex,
// and asserts the resolved colors hold for EVERY scheme.
//
// This is a GREEN-state test: the CSS tokens already satisfy it, so it should
// pass on the current scaffold and continue guarding the palette in CI.
// (The RED test is StatusSeriesChart.test.tsx — a component that is not built yet.)

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMES, type SchemeId } from '@/theme/schemes';

// ---------------------------------------------------------------------------
// Color helpers (self-contained, no deps)
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function hslToHex(h: number, sPct: number, lPct: number): string {
  const s = sPct / 100;
  const l = lPct / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// CSS HSL is the extended space [0,360); wrap into [0,360).
function rgbToHue(r: number, g: number, b: number): number {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rr) h = ((gg - bb) / d) % 6;
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  let deg = h * 60;
  if (deg < 0) deg += 360;
  return deg;
}

function hexToHue(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHue(r, g, b);
}

function circularHueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------------
// Parse the live token values straight out of index.css (the single source of
// truth for each scheme's palette).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../index.css');
const css = readFileSync(cssPath, 'utf8');

// { 'deep-ocean': { idle: '4 82.9% 65.7%', error: '203 92.2% 50%', ... }, ... }
function parseSchemeTokens(source: string, schemeId: SchemeId): Record<string, string> {
  const start = source.indexOf(`[data-theme="${schemeId}"]`);
  if (start === -1) throw new Error(`[data-theme="${schemeId}"] block not found in index.css`);
  const openBrace = source.indexOf('{', start);
  const block = source.slice(openBrace + 1, source.indexOf('}', openBrace));
  const out: Record<string, string> = {};
  const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2].trim();
  return out;
}

function parseHsl(value: string): [number, number, number] {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) throw new Error(`expected HSL triplet, got: ${value}`);
  return [
    Number(parts[0]),
    Number(parts[1].replace('%', '')),
    Number(parts[2].replace('%', '')),
  ];
}

function resolveHex(schemeId: SchemeId, token: string): string {
  const tokens = parseSchemeTokens(css, schemeId);
  const raw = tokens[token];
  if (raw === undefined) throw new Error(`token --${token} missing for scheme ${schemeId}`);
  const [h, s, l] = parseHsl(raw);
  return hslToHex(h, s, l);
}

// Canonical traffic-light targets.
const IDLE_RED_HEX = '#f0685f'; // coral-red — idle
const ERROR_BLUE_HEX = '#0a9bf5'; // accent-blue — error (EXACT)
const IDLE_RED_HUE = 4; // red family, hue ~4
const HUE_TOLERANCE = 5; // ±HSL rounding + integer rounding
const CHANNEL_TOLERANCE = 4; // per-channel rounding tolerance for "close to"

function isCloseToHex(hex: string, target: string, channelTol = CHANNEL_TOLERANCE): boolean {
  const [tr, tg, tb] = hexToRgb(target);
  const [r, g, b] = hexToRgb(hex);
  return (
    Math.abs(r - tr) <= channelTol &&
    Math.abs(g - tg) <= channelTol &&
    Math.abs(b - tb) <= channelTol
  );
}

describe('traffic-light token mapping across all 5 schemes', () => {
  it('exposes exactly the 5 runtime-switchable schemes from the theme module', () => {
    expect(SCHEMES.map((s) => s.id)).toEqual([
      'deep-ocean',
      'night-harbor',
      'foggy-dusk',
      'cyan-tech',
      'indigo-shift',
    ]);
  });

  it('defines --idle and --error tokens in index.css for every scheme', () => {
    for (const s of SCHEMES) {
      const tokens = parseSchemeTokens(css, s.id);
      expect(tokens.idle, `--idle missing for ${s.id}`).toBeDefined();
      expect(tokens.error, `--error missing for ${s.id}`).toBeDefined();
    }
  });

  for (const s of SCHEMES) {
    describe(`scheme: ${s.id}`, () => {
      it('resolves --idle to the coral-red family (hue ~4) and ≈ #f0685f', () => {
        const hex = resolveHex(s.id, 'idle');
        const hue = hexToHue(hex);
        expect(hue).toBeGreaterThanOrEqual(IDLE_RED_HUE - HUE_TOLERANCE);
        expect(hue).toBeLessThanOrEqual(IDLE_RED_HUE + HUE_TOLERANCE);
        expect(circularHueDelta(hue, IDLE_RED_HUE)).toBeLessThanOrEqual(HUE_TOLERANCE);
        expect(isCloseToHex(hex, IDLE_RED_HEX)).toBe(true);
      });

      it('resolves --error to EXACTLY #0a9bf5 (accent-blue)', () => {
        const hex = resolveHex(s.id, 'error');
        expect(hex.toLowerCase()).toBe(ERROR_BLUE_HEX);
      });

      it('never maps idle to the blue/error family (red is NOT failure)', () => {
        const hue = hexToHue(resolveHex(s.id, 'idle'));
        // Blue family sits near hue 203 (accent) — idle must be far from it.
        expect(circularHueDelta(hue, 203)).toBeGreaterThan(60);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Chunk 3b — legend palette isolation
//
// The fleet-metrics legend must NEVER reuse a traffic-light color: a swatch that
// matches --healthy/--prefill/--error/--idle reads as a state signal instead of
// a series identity. These guards pin the dedicated --legend-1..6 scale: defined
// for every scheme, never byte-identical to a traffic token, hue-separated from
// the traffic hues AND from each other, and >=3:1 against the scheme's own
// --card background (WCAG 1.4.11 graphical-object floor).
// ---------------------------------------------------------------------------

const LEGEND_TOKENS = [
  'legend-1',
  'legend-2',
  'legend-3',
  'legend-4',
  'legend-5',
  'legend-6',
];

// The traffic-light set the legend must stay distinguishable from.
const TRAFFIC_TOKENS = ['healthy', 'positive', 'prefill', 'warning', 'error', 'idle', 'disabled'];

const MIN_LEGEND_PAIRWISE_HUE_DELTA = 20;
const MIN_LEGEND_VS_TRAFFIC_HUE_DELTA = 15;
const MIN_GRAPHICAL_CONTRAST = 3.0;

// --chart-1 is frozen: MetricLineChart's default stroke and stateTokens'
// unclassified-series default both hard-code it. Legend work must not move it.
const CHART1_FROZEN_VALUE = '203 92.2% 50%';

function srgbChannelToLinear(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

// WCAG contrast ratio: (L_lighter + 0.05) / (L_darker + 0.05).
function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

// A scheme's six legend HSL triplets; fails loudly if a slot is missing.
function legendTriplets(schemeId: SchemeId): Array<[number, number, number]> {
  const tokens = parseSchemeTokens(css, schemeId);
  return LEGEND_TOKENS.map((name) => {
    const raw = tokens[name];
    expect(raw, `--${name} missing for scheme ${schemeId}`).toBeDefined();
    return parseHsl(raw as string);
  });
}

function trafficTriplets(schemeId: SchemeId): Array<{ name: string; hsl: [number, number, number] }> {
  const tokens = parseSchemeTokens(css, schemeId);
  return TRAFFIC_TOKENS.map((name) => {
    const raw = tokens[name];
    expect(raw, `--${name} missing for scheme ${schemeId}`).toBeDefined();
    return { name, hsl: parseHsl(raw as string) };
  });
}

function cardHex(schemeId: SchemeId): string {
  const tokens = parseSchemeTokens(css, schemeId);
  expect(tokens.card, `--card missing for scheme ${schemeId}`).toBeDefined();
  const [h, s, l] = parseHsl(tokens.card);
  return hslToHex(h, s, l);
}

describe('legend palette isolation (chunk 3b)', () => {
  it('keeps --chart-1 frozen at 203 92.2% 50% in every scheme (regression guard)', () => {
    for (const s of SCHEMES) {
      const tokens = parseSchemeTokens(css, s.id);
      expect(tokens['chart-1'], `--chart-1 missing for ${s.id}`).toBe(CHART1_FROZEN_VALUE);
    }
  });

  for (const s of SCHEMES) {
    describe(`scheme: ${s.id}`, () => {
      it('defines all six --legend-N tokens', () => {
        const tokens = parseSchemeTokens(css, s.id);
        for (const name of LEGEND_TOKENS) {
          expect(tokens[name], `--${name} missing for scheme ${s.id}`).toBeDefined();
        }
      });

      it('never sets a legend value byte-identical to a traffic-light value', () => {
        const tokens = parseSchemeTokens(css, s.id);
        for (const legend of LEGEND_TOKENS) {
          const legendValue = (tokens[legend] ?? '').trim();
          for (const traffic of TRAFFIC_TOKENS) {
            const trafficValue = (tokens[traffic] ?? '').trim();
            expect(
              legendValue === trafficValue,
              `--${legend} (${legendValue}) collides with traffic-light --${traffic} in ${s.id}`
            ).toBe(false);
          }
        }
      });

      it('keeps every legend hue at least 15deg from every traffic-light hue', () => {
        const legends = legendTriplets(s.id);
        const traffics = trafficTriplets(s.id);
        legends.forEach((legendHsl, i) => {
          for (const traffic of traffics) {
            const delta = circularHueDelta(legendHsl[0], traffic.hsl[0]);
            expect(
              delta >= MIN_LEGEND_VS_TRAFFIC_HUE_DELTA,
              `--${LEGEND_TOKENS[i]} hue ${legendHsl[0]} is only ${delta}deg from --${traffic.name} hue ${traffic.hsl[0]} in ${s.id}`
            ).toBe(true);
          }
        });
      });

      it('keeps the six legend hues at least 20deg apart from each other', () => {
        const legends = legendTriplets(s.id);
        for (let i = 0; i < legends.length; i += 1) {
          for (let j = i + 1; j < legends.length; j += 1) {
            const delta = circularHueDelta(legends[i][0], legends[j][0]);
            expect(
              delta >= MIN_LEGEND_PAIRWISE_HUE_DELTA,
              `--${LEGEND_TOKENS[i]} and --${LEGEND_TOKENS[j]} are only ${delta}deg apart in ${s.id}`
            ).toBe(true);
          }
        }
      });

      it('keeps every legend color at least 3:1 against the scheme --card background', () => {
        const legends = legendTriplets(s.id);
        const background = cardHex(s.id);
        legends.forEach((legendHsl, i) => {
          const hex = hslToHex(legendHsl[0], legendHsl[1], legendHsl[2]);
          const ratio = contrastRatio(hex, background);
          expect(
            ratio >= MIN_GRAPHICAL_CONTRAST,
            `--${LEGEND_TOKENS[i]} ${hex} on card ${background} is only ${ratio.toFixed(2)}:1 in ${s.id}`
          ).toBe(true);
        });
      });
    });
  }

  describe('source guards', () => {
    it('FleetMetricsPanel cycles the six --legend-N tokens and never --chart-', () => {
      const source = readFileSync(resolve(here, '../components/FleetMetricsPanel.tsx'), 'utf8');
      expect(
        source.includes('--legend-${(i % 6) + 1}'),
        'FleetMetricsPanel.tsx must cycle hsl(var(--legend-${(i % 6) + 1}))'
      ).toBe(true);
      expect(
        source.includes('--chart-'),
        'FleetMetricsPanel.tsx must not reference --chart- at all'
      ).toBe(false);
    });

    it('stateTokens.ts and MetricLineChart.tsx still hard-code hsl(var(--chart-1))', () => {
      const stateTokensSource = readFileSync(
        resolve(here, '../components/charts/stateTokens.ts'),
        'utf8'
      );
      const lineChartSource = readFileSync(
        resolve(here, '../components/charts/MetricLineChart.tsx'),
        'utf8'
      );
      expect(stateTokensSource.includes('hsl(var(--chart-1))')).toBe(true);
      expect(lineChartSource.includes('hsl(var(--chart-1))')).toBe(true);
    });
  });
});
