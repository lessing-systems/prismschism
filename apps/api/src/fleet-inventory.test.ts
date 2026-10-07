import { describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  applyTopN,
  createRequestHandler,
  METRICS,
  type QueryFn,
  type SeriesPoint,
} from './server';

// B3-B7: the deployment roster. Backends come from deployment_inventory, not
// from traffic, so a registered-but-idle deployment must still render as 0.

function makeQuery(spec: {
  valueRows: unknown[];
  healthRows?: unknown[];
  inventoryRows?: unknown[];
}) {
  return vi.fn(async (sql: string) => {
    if (sql.includes('instance_health')) {
      return { rows: [{ last_up_ts: new Date(), last_seen_ts: new Date() }] };
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

async function getFull(base: string, qs: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/series?${qs}`);
  return { status: res.status, body: (await res.json()) as any };
}

function valueSql(q: { mock: { calls: unknown[][] } }): string {
  const call = q.mock.calls.find(([sql]) => String(sql).includes('CROSS JOIN'));
  if (!call) throw new Error(`no value query captured in ${q.mock.calls.length} calls`);
  return String(call[0]);
}

const BUCKET = new Date('2026-09-29T10:00:00.000Z');

describe('B3 — the removed HAVING SUM(value) > 0 stays removed', () => {
  it('emits no HAVING clause at all in the derived deployment query', async () => {
    const q = makeQuery({ valueRows: [] });
    const srv = await startServer(q);
    try {
      await getFull(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      const sql = valueSql(q);
      expect(/HAVING/i.test(sql)).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('builds a dense roster spine so an idle backend still gets a row at 0', async () => {
    const q = makeQuery({ valueRows: [] });
    const srv = await startServer(q);
    try {
      await getFull(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      const sql = valueSql(q);
      expect(sql).toContain('deployment_inventory');
      expect(sql).toContain('CROSS JOIN allgroups');
      expect(sql).toContain('COALESCE(n.v, 0)');
    } finally {
      await srv.close();
    }
  });

  it('renders a rostered backend with no metric rows as value 0, not as a gap', async () => {
    const q = makeQuery({
      valueRows: [
        { bucket: BUCKET, model_id: 'mid-idle', num: null, den: '60', in_inventory: true },
        { bucket: BUCKET, model_id: 'mid-busy', num: '600', den: '60', in_inventory: true },
      ],
    });
    const srv = await startServer(q);
    try {
      const { status, body } = await getFull(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      const idle = body.find((p: SeriesPoint) => p.group === 'mid-idle');
      expect(idle).toBeDefined();
      expect(idle.value).toBe(0);
      expect(body.find((p: SeriesPoint) => p.group === 'mid-busy').value).toBe(10);
    } finally {
      await srv.close();
    }
  });
});

describe('B4 — requests_per_min reads the raw hypertable', () => {
  it('groups by model_id off the raw requests table, not a model_id-less cagg', async () => {
    const q = makeQuery({
      valueRows: [{ bucket: BUCKET, model_id: 'mid-a', num: '30', den: '60' }],
    });
    const srv = await startServer(q);
    try {
      const { status, body } = await getFull(srv.base, 'metric=requests_per_min&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
      const sql = valueSql(q);
      expect(sql).toMatch(/FROM requests\b/);
      expect(sql).not.toMatch(/requests_(1m|5m|1h)\b/);
      expect(sql).toContain('model_id');
    } finally {
      await srv.close();
    }
  });
});

describe('B5 — the unassigned group is never filtered out', () => {
  it('survives top-N even with no inventory exemption', () => {
    const points: SeriesPoint[] = [
      { t: 'x', group: 'big', value: 100 },
      { t: 'x', group: 'unassigned', value: 1 },
      { t: 'x', group: 'dropped', value: 50 },
    ];
    const kept = applyTopN(points, 1, new Set());
    expect(kept.some((p) => p.group === 'unassigned')).toBe(true);
    expect(kept.some((p) => p.group === 'dropped')).toBe(false);
  });

  it('is returned by the endpoint when the scraper parked data there', async () => {
    const q = makeQuery({
      valueRows: [{ bucket: BUCKET, model_id: 'unassigned', num: '60', den: '60', in_inventory: false }],
    });
    const srv = await startServer(q);
    try {
      const { body } = await getFull(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(body.some((p: SeriesPoint) => p.group === 'unassigned')).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe('B6 — inventory rows are exempt from API_TOP_N truncation', () => {
  const many = (): SeriesPoint[] => [
    { t: 'x', group: 'inv-quiet', value: 1 },
    { t: 'x', group: 'inv-quiet-2', value: 2 },
    { t: 'x', group: 'loud-a', value: 900 },
    { t: 'x', group: 'loud-b', value: 800 },
  ];

  it('keeps every inventoried group while truncating the rest to top-N', () => {
    const kept = applyTopN(many(), 1, new Set(['inv-quiet', 'inv-quiet-2']));
    const groups = new Set(kept.map((p) => p.group));
    expect(groups.has('inv-quiet')).toBe(true);
    expect(groups.has('inv-quiet-2')).toBe(true);
    expect(groups.has('loud-a')).toBe(true);
    expect(groups.has('loud-b')).toBe(false);
  });

  it('truncates non-inventory groups when nothing is exempt', () => {
    const groups = new Set(applyTopN(many(), 1, new Set()).map((p) => p.group));
    expect(groups.has('inv-quiet')).toBe(false);
    expect(groups.has('loud-a')).toBe(true);
  });

  it('feeds the exemption set from deployment_inventory, not from traffic', async () => {
    const q = makeQuery({
      valueRows: [{ bucket: BUCKET, model_id: 'mid-a', num: '60', den: '60', in_inventory: true }],
      inventoryRows: [{ grp: 'mid-a' }, { grp: 'mid-quiet' }],
    });
    const srv = await startServer(q);
    try {
      await getFull(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      const probe = q.mock.calls.find(([sql]) => String(sql).includes('deployment_inventory'));
      expect(probe).toBeDefined();
    } finally {
      await srv.close();
    }
  });
});

describe('B7 — input_tps is valid, prefill_tps is gone', () => {
  it('lists input_tps and no longer lists prefill_tps', () => {
    expect(METRICS).toContain('input_tps');
    expect(METRICS).not.toContain('prefill_tps');
  });

  it('serves input_tps', async () => {
    const q = makeQuery({ valueRows: [{ bucket: BUCKET, model_id: 'mid-a', num: '300', den: '60' }] });
    const srv = await startServer(q);
    try {
      const { status } = await getFull(srv.base, 'metric=input_tps&range=1h&group=model_id');
      expect(status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('rejects prefill_tps with 400', async () => {
    const q = makeQuery({ valueRows: [] });
    const srv = await startServer(q);
    try {
      const { status, body } = await getFull(srv.base, 'metric=prefill_tps&range=1h&group=model_id');
      expect(status).toBe(400);
      expect(body.error).toContain('prefill_tps');
    } finally {
      await srv.close();
    }
  });
});
