import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  applyTopN,
  buildScrapeHealthSql,
  createRequestHandler,
  DEFAULT_SCRAPE_DOWN_AFTER_MS,
  resolveScrapeDownAfterMs,
  scrapeStatus,
  stampScrapeDown,
  type QueryFn,
  type SeriesPoint,
} from './server';

// B1: scrape-down stamping. The existing suite never exercises it because its
// makeDispatchingQuery does not recognise the instance_health probe SQL, so the
// probe falls through to the value rows and the handler reads UNKNOWN. This
// file owns a probe-aware dispatcher.

type Probe =
  | { kind: 'rows'; rows: Array<{ last_up_ts?: Date | string | null; last_seen_ts?: Date | string | null }> }
  | { kind: 'throw' };

function makeScrapeQuery(spec: {
  valueRows: unknown[];
  healthRows?: unknown[];
  inventoryRows?: unknown[];
  probe: Probe;
}) {
  return vi.fn(async (sql: string) => {
    if (sql.includes('instance_health')) {
      if (spec.probe.kind === 'throw') throw new Error('injected probe failure');
      return { rows: spec.probe.rows };
    }
    if (sql.includes('AS label')) return { rows: [] };
    if (sql.includes('deployment_health')) return { rows: spec.healthRows ?? [] };
    if (sql.includes('out_inc')) return { rows: [] };
    if (sql.trimStart().startsWith('SELECT DISTINCT') && sql.includes('deployment_inventory')) {
      return { rows: spec.inventoryRows ?? [] };
    }
    return { rows: spec.valueRows };
  }) as unknown as QueryFn & { mock: { calls: unknown[][] } };
}

async function startServer(query: QueryFn) {
  const server = createServer(createRequestHandler({ query }));
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function getFull(base: string, qs: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}/api/series?${qs}`);
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

const BUCKET = new Date('2026-09-29T10:00:00.000Z');
const VALUE_ROWS = [
  { bucket: BUCKET, model_id: 'mid-a', num: '600', den: '60', in_inventory: true },
  { bucket: BUCKET, model_id: 'mid-b', num: '120', den: '60', in_inventory: true },
];
const QS = 'metric=decode_tps&range=1h&group=model_id';

describe('scrape-down stamping — resolveScrapeDownAfterMs', () => {
  it('defaults to 75000 ms', () => {
    expect(DEFAULT_SCRAPE_DOWN_AFTER_MS).toBe(75000);
    expect(resolveScrapeDownAfterMs({})).toBe(75000);
    expect(resolveScrapeDownAfterMs({ SCRAPE_DOWN_AFTER_MS: '' })).toBe(75000);
    expect(resolveScrapeDownAfterMs({ SCRAPE_DOWN_AFTER_MS: 'nonsense' })).toBe(75000);
    expect(resolveScrapeDownAfterMs({ SCRAPE_DOWN_AFTER_MS: '0' })).toBe(75000);
  });

  it('honours a positive override', () => {
    expect(resolveScrapeDownAfterMs({ SCRAPE_DOWN_AFTER_MS: '5000' })).toBe(5000);
  });
});

describe('scrape-down stamping — scrapeStatus window', () => {
  const now = Date.parse('2026-09-29T10:00:00.000Z');

  it('is up inside the window and reports staleness', () => {
    const s = scrapeStatus(new Date(now - 5000), now, 75000);
    expect(s.up).toBe(true);
    expect(s.stalenessMs).toBe(5000);
  });

  it('stays up exactly AT the default threshold boundary (inclusive)', () => {
    const s = scrapeStatus(new Date(now - 75000), now, 75000);
    expect(s.up).toBe(true);
    expect(s.stalenessMs).toBe(75000);
  });

  it('stays up exactly at a custom threshold boundary (inclusive)', () => {
    const s = scrapeStatus(new Date(now - 30000), now, 30000);
    expect(s.up).toBe(true);
    expect(s.stalenessMs).toBe(30000);
  });

  it('flips to down one millisecond PAST the threshold', () => {
    const s = scrapeStatus(new Date(now - 75001), now, 75000);
    expect(s.up).toBe(false);
    expect(s.stalenessMs).toBe(75001);
  });

  it('is down once the newest health row ages past the window', () => {
    const s = scrapeStatus(new Date(now - 76000), now, 75000);
    expect(s.up).toBe(false);
    expect(s.stalenessMs).toBe(76000);
  });

  it('is down when there is no recent health row (last_seen_ts NULL)', () => {
    expect(scrapeStatus(null, now, 75000)).toEqual({ up: false, lastScrapeTs: null, stalenessMs: null });
  });
});

describe('scrape-down stamping — stampScrapeDown', () => {
  it('overwrites value/state and flags synthetic while keeping identity fields', () => {
    const out = stampScrapeDown([
      { t: '2026-09-29T10:00:00.000Z', group: 'mid-a', value: 12, state: 'healthy', litellm_model_name: 'n' },
    ] as SeriesPoint[]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      t: '2026-09-29T10:00:00.000Z',
      group: 'mid-a',
      litellm_model_name: 'n',
      value: 0,
      state: 'error',
      synthetic: true,
    });
  });
});

describe('scrape-down stamping — probe SQL', () => {
  it('probes instance_health with the threshold as a millisecond interval', () => {
    const sql = buildScrapeHealthSql();
    expect(sql).toContain('FROM instance_health');
    expect(sql).toContain("$1 * interval '1 millisecond'");
  });

  it('selects both last_seen_ts and last_up_ts; liveness is newest row regardless of up', () => {
    const sql = buildScrapeHealthSql();
    // LIVENESS (drives down/up, X-Scrape-Down and X-Scrape-Staleness-Ms): the
    // newest health row of ANY kind, so it is the UNFILTERED max(ts).
    expect(sql).toContain('max(ts) AS last_seen_ts');
    // LAST-SUCCESS (diagnostic; feeds X-Scrape-Last-Success): the newest row
    // FILTERED to up=true. It is never used for the down/up determination.
    expect(sql).toContain('max(ts) FILTER (WHERE up) AS last_up_ts');
  });
});

describe('GET /api/series — scrape-down stamping end to end', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('leaves points untouched when last_seen_ts AND last_up_ts are both fresh', async () => {
    const q = makeScrapeQuery({
      valueRows: VALUE_ROWS,
      probe: {
        kind: 'rows',
        rows: [{ last_up_ts: new Date(Date.now() - 2000), last_seen_ts: new Date(Date.now() - 1000) }],
      },
    });
    const srv = await startServer(q);
    try {
      const { status, body, headers } = await getFull(srv.base, QS);
      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].value).toBe(10);
      for (const p of body) {
        expect(p.synthetic).toBeUndefined();
        expect(p.state).not.toBe('error');
      }
      expect(headers.get('x-scrape-down')).toBe('false');
      // Liveness (and therefore X-Scrape-Staleness-Ms) is driven by last_seen_ts,
      // NOT last_up_ts: the row's last_seen_ts is ~1s old and last_up_ts ~2s old,
      // so the staleness must be < 1500 (from last_seen) and not ~2000 (last_up).
      // Exact value is timing-dependent, so bound it rather than pin it.
      const staleness = Number(headers.get('x-scrape-staleness-ms'));
      expect(Number.isFinite(staleness)).toBe(true);
      expect(staleness).toBeGreaterThanOrEqual(0);
      expect(staleness).toBeLessThan(1500);
      // X-Scrape-Last-Success is driven by last_up_ts -> non-empty when fresh.
      expect(headers.get('x-scrape-last-success')).not.toBe('');
    } finally {
      await srv.close();
    }
  });

  it('stamps every point to a synthetic error zero when last_seen_ts is old (stale scraper)', async () => {
    const q = makeScrapeQuery({
      valueRows: VALUE_ROWS,
      probe: {
        kind: 'rows',
        rows: [{ last_up_ts: new Date(Date.now() - 200000), last_seen_ts: new Date(Date.now() - 200000) }],
      },
    });
    const srv = await startServer(q);
    try {
      const { status, body, headers } = await getFull(srv.base, QS);
      expect(status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
      for (const p of body) {
        expect(p.value).toBe(0);
        expect(p.state).toBe('error');
        expect(p.synthetic).toBe(true);
      }
      expect(headers.get('x-scrape-down')).toBe('true');
    } finally {
      await srv.close();
    }
  });

  it('dead-scraper regression: both last_up_ts and last_seen_ts NULL => header true + synthetic zeros', async () => {
    const q = makeScrapeQuery({
      valueRows: VALUE_ROWS,
      probe: { kind: 'rows', rows: [{ last_up_ts: null, last_seen_ts: null }] },
    });
    const srv = await startServer(q);
    try {
      const { body, headers } = await getFull(srv.base, QS);
      expect(body.length).toBeGreaterThan(0);
      for (const p of body) {
        expect(p.value).toBe(0);
        expect(p.state).toBe('error');
        expect(p.synthetic).toBe(true);
      }
      expect(headers.get('x-scrape-down')).toBe('true');
    } finally {
      await srv.close();
    }
  });

  it('does NOT stamp a target outage: last_up_ts old but last_seen_ts fresh', async () => {
    // last_up_ts is OLD (~200s) — the target has not succeeded recently;
    // last_seen_ts is FRESH (~2s) — the scraper itself is clearly alive.
    const upTs = new Date(Date.now() - 200000);
    const seenTs = new Date(Date.now() - 2000);
    const q = makeScrapeQuery({
      valueRows: VALUE_ROWS,
      probe: { kind: 'rows', rows: [{ last_up_ts: upTs, last_seen_ts: seenTs }] },
    });
    const srv = await startServer(q);
    try {
      const { status, body, headers } = await getFull(srv.base, QS);
      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].value).toBe(10);
      for (const p of body) {
        expect(p.synthetic).toBeUndefined();
        expect(p.state).not.toBe('error');
      }
      // Liveness is driven by last_seen_ts (fresh) -> up, so no stamping.
      expect(headers.get('x-scrape-down')).toBe('false');
      // X-Scrape-Last-Success is driven by last_up_ts, NOT last_seen_ts: an old
      // (but present) success still carries its timestamp, so the header equals
      // the OLD upTs — proving it reads last_up_ts, not the fresh last_seen_ts.
      expect(headers.get('x-scrape-last-success')).toBe(upTs.toISOString());
    } finally {
      await srv.close();
    }
  });

  it('fails OPEN with no stamping when the probe query throws', async () => {
    const q = makeScrapeQuery({ valueRows: VALUE_ROWS, probe: { kind: 'throw' } });
    const srv = await startServer(q);
    try {
      const { status, body, headers } = await getFull(srv.base, QS);
      expect(status).toBe(200);
      expect(body[0].value).toBe(10);
      for (const p of body) {
        expect(p.synthetic).toBeUndefined();
        expect(p.state).not.toBe('error');
      }
      expect(headers.get('x-scrape-down')).toBe('unknown');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('fails OPEN with no stamping when the probe returns no rows', async () => {
    const q = makeScrapeQuery({ valueRows: VALUE_ROWS, probe: { kind: 'rows', rows: [] } });
    const srv = await startServer(q);
    try {
      const { status, body, headers } = await getFull(srv.base, QS);
      expect(status).toBe(200);
      expect(body[0].value).toBe(10);
      for (const p of body) {
        expect(p.synthetic).toBeUndefined();
      }
      expect(headers.get('x-scrape-down')).toBe('unknown');
    } finally {
      await srv.close();
    }
  });
});

describe('applyTopN — synthetic points are excluded from ranking', () => {
  const pt = (group: string, value: number, synthetic = false): SeriesPoint => ({
    t: '2026-09-29T10:00:00.000Z',
    group,
    value,
    synthetic,
  });

  it('does not let synthetic filler out-rank a real group', () => {
    const points = [
      pt('real-a', 10),
      pt('mixed-b', 5),
      pt('mixed-b', 1000, true),
    ];
    const kept = applyTopN(points, 1, new Set());
    expect(kept.some((p) => p.group === 'real-a')).toBe(true);
    expect(kept.some((p) => p.group === 'mixed-b' && p.synthetic === false)).toBe(false);
    expect(kept.some((p) => p.group === 'mixed-b' && p.synthetic === true)).toBe(true);
  });

  it('never truncates synthetic points away', () => {
    const points = [pt('big', 100), pt('small', 1), pt('ghost', 0, true)];
    const kept = applyTopN(points, 1, new Set());
    expect(kept.some((p) => p.group === 'big')).toBe(true);
    expect(kept.some((p) => p.group === 'small')).toBe(false);
    expect(kept.some((p) => p.group === 'ghost')).toBe(true);
  });

  it('ranks purely on real measurements', () => {
    const points = [pt('a', 1), pt('a', 2), pt('b', 4)];
    expect(applyTopN(points, 1, new Set()).some((p) => p.group === 'b')).toBe(true);
  });
});
