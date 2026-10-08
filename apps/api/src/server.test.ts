/**
 * server.test.ts — tests-first (TDD) spec for the API server module (./server).
 *
 * The implementation (apps/api/src/server.ts) is authored later; these tests
 * pin its public surface verbatim. They run against a FAKE `QueryFn` and a real
 * `node:http` server bound to an ephemeral port — NO live database anywhere.
 *
 * Design decision under guard:
 *   storage NULL (idle)      -> API emits 0
 *   missing row (down/unknown) -> API emits null / gap
 *   "The frontend never inspects storage — the API performs this conversion
 *    at the boundary."
 * The "errors" metric has no DB backing (by design). It is validated as a known metric and short-circuits to an empty series,
 * warning rather than querying.
 *
 * Run (after the implementation lands) from apps/api with the project's vitest:
 *   vitest run src/server.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  attachStates,
  buildActivitySql,
  buildBreakdownSql,
  buildBridgeSql,
  buildDerivedSql,
  buildHealthSql,
  buildKpiTotalRawSql,
  buildKpiTotalSql,
  buildLabelToModelIds,
  buildRawSeriesSql,
  buildSeriesSql,
  buildStateByGroup,
  buildTtftClassifierSql,
  countHealthyDeployments,
  createRequestHandler,
  DERIVED,
  DERIVED_BUCKET_SECONDS,
  DERIVED_INTERVAL,
  deriveActivityStates,
  derivedPoints,
  GROUPS,
  inventoryFingerprint,
  isDerivedMetric,
  kpiTotal,
  METRICS,
  parseEnvNumber,
  parseThresholdPct,
  RANGE_SECONDS,
  TIER_MAP,
  toBreakdown,
  toPoints,
  tierForRange,
  TTFT_CLASSIFIER_AXES,
  validateBreakdownParams,
  validateKpiParams,
  validateSeriesParams,
  valueColumn,
} from './server';
import type {
  ActivityRow,
  ActivityState,
  BridgeRow,
  DeploymentState,
  DerivedRow,
  HealthRow,
  QueryFn,
  SeriesPoint,
} from './server';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A plain `QueryFn` extended with the vitest `Mock` affordances the
 *  integration tests rely on (`mockResolvedValue`, `.mock.calls`, `mockClear`).
 *  Confined to the test file so production code never references vitest. */
type FakeQuery = QueryFn & {
  mockResolvedValue: (v: { rows: any[] }) => void;
  mock: { calls: [string, unknown[]][] };
  mockClear: () => void;
};

/**
 * A `vi.fn()` that doubles as the fake `QueryFn`: it records `(sql, params)`
 * calls so tests can assert on the generated SQL and the parameterized interval
 * seconds, while `mockResolvedValue` supplies the canned rows.
 */
function makeFakeQuery(): FakeQuery {
  return vi.fn() as unknown as FakeQuery;
}

/**
 * A `vi.fn()` that dispatches based on the SQL string, routing four query
 * families: the label→model_id bridge (identified by its `AS label` projection)
 * returns `bridgeRows`; queries touching `deployment_health` return
 * `healthRows`; the activity-increments query (identified by its `out_inc`
 * projection) returns `activityRows`; and everything else (the value series
 * query) returns `valueRows`. Used by the deployment-health and activity-state
 * integration tests. `bridgeRows` and `activityRows` default to `[]`, so the
 * existing two/three-argument call sites keep working unchanged.
 */
function makeDispatchingQuery(valueRows: any[], healthRows: any[], bridgeRows: any[] = [], activityRows: any[] = []): FakeQuery {
  return vi.fn(async (sql: string, _params: unknown[]) => {
    if (sql.includes("AS label")) return { rows: bridgeRows };
    if (sql.includes("deployment_health")) return { rows: healthRows };
    if (sql.includes("out_inc")) return { rows: activityRows };
    return { rows: valueRows };
  }) as unknown as FakeQuery;
}

/**
 * Start the real HTTP server (via the request handler) on an ephemeral port and
 * return its base URL. Used by the integration describe block.
 */
async function startServer(query: QueryFn): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(createRequestHandler({ query }));
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** GET `${base}/api/series?${qs}` and return status + parsed JSON body. */
async function getSeries(base: string, qs: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/series?${qs}`);
  const body = await res.json();
  return { status: res.status, body };
}

/** GET `${base}${path}` and return status + parsed JSON body. */
async function get(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

/** Read the single recorded (sql, params) pair from a fake QueryFn. */
function lastCall(fake: FakeQuery): [sql: string, params: unknown[]] {
  const call = fake.mock.calls[fake.mock.calls.length - 1];
  return [String(call[0]), (call[1] as unknown[]) ?? []];
}

/** Read the FIRST recorded (sql, params) pair from a fake QueryFn. The value
 *  query is issued before the deployment_health query, so the first call is the
 *  value query. */
function firstCall(fake: FakeQuery): [sql: string, params: unknown[]] {
  const call = fake.mock.calls[0];
  return [String(call[0]), (call[1] as unknown[]) ?? []];
}

// ---------------------------------------------------------------------------
// Unit — pure functions (no DB, no HTTP)
// ---------------------------------------------------------------------------

describe('server — unit (pure functions, no DB/HTTP)', () => {
  describe('tierForRange — range → bucket tier', () => {
    it('maps 1h to the 1m bucket', () => {
      expect(tierForRange('1h')).toBe('1m');
    });
    it('maps 24h to the 5m bucket', () => {
      expect(tierForRange('24h')).toBe('5m');
    });
    it('maps 7d to the 1h bucket', () => {
      expect(tierForRange('7d')).toBe('1h');
    });
    it('returns undefined for an unknown range', () => {
      expect(tierForRange('30d')).toBeUndefined();
    });
  });

  describe('valueColumn — metric → value column', () => {
    it('returns avg_value for latency (a gauge, not a counter)', () => {
      expect(valueColumn('latency')).toBe('avg_value');
    });
    it.each(['requests', 'tokens', 'spend', 'limits'])('returns sum_value for the %s counter', (m) => {
      expect(valueColumn(m)).toBe('sum_value');
    });
    it('returns undefined for errors (the errors metric has no DB backing)', () => {
      expect(valueColumn('errors')).toBeUndefined();
    });
  });

  describe('validateSeriesParams — endpoint query validation', () => {
    const q = (metric?: string, range?: string, group?: string) => ({ metric, range, group });

    it('accepts a valid requests/1h/model combo and echoes the values', () => {
      expect(validateSeriesParams(q('requests', '1h', 'model'))).toEqual({
        ok: true,
        metric: 'requests',
        range: '1h',
        group: 'model',
      });
    });

    it('accepts a valid errors/24h/api_provider combo (errors is a known metric)', () => {
      expect(validateSeriesParams(q('errors', '24h', 'api_provider'))).toEqual({
        ok: true,
        metric: 'errors',
        range: '24h',
        group: 'api_provider',
      });
    });

    it('rejects an unknown metric', () => {
      const r = validateSeriesParams(q('bogus', '1h', 'model'));
      expect(r.ok).toBe(false);
      if (r.ok === false) {
        expect(typeof r.error).toBe('string');
        expect(r.error).not.toBe('');
      } else {
        throw new Error('expected validation to fail for an unknown metric');
      }
    });

    it('rejects an unknown range', () => {
      const r = validateSeriesParams(q('requests', '30d', 'model'));
      expect(r.ok).toBe(false);
      if (r.ok === false) {
        expect(typeof r.error).toBe('string');
        expect(r.error).not.toBe('');
      } else {
        throw new Error('expected validation to fail for an unknown range');
      }
    });

    it('rejects a missing metric', () => {
      expect(validateSeriesParams(q(undefined, '1h', 'model')).ok).toBe(false);
    });

    it('rejects a missing range', () => {
      expect(validateSeriesParams(q('requests', undefined, 'model')).ok).toBe(false);
    });

    it('rejects a missing group (the endpoint requires a group)', () => {
      expect(validateSeriesParams(q('requests', '1h', undefined)).ok).toBe(false);
    });

    it('rejects an unknown group', () => {
      expect(validateSeriesParams(q('requests', '1h', 'user')).ok).toBe(false);
    });
  });

  describe('buildSeriesSql — SQL construction (parameterized interval)', () => {
    it('builds a 1m/requests/model query with sum_value, grouping by bucket+model', () => {
      const sql = buildSeriesSql('requests', '1m', 'model');
      expect(sql).toContain('requests_1m');
      expect(sql).toContain('SUM(sum_value)');
      expect(sql).toContain('GROUP BY bucket, model');
      expect(sql).toContain('ORDER BY bucket');
      // the interval seconds are parameterized, not inlined
      expect(sql).toContain('$1');
    });

    it('builds a 5m/latency/api_provider query using avg_value', () => {
      const sql = buildSeriesSql('latency', '5m', 'api_provider');
      expect(sql).toContain('latency_5m');
      expect(sql).toContain('avg_value');
    });
  });

  describe('toPoints — rows → series points', () => {
    it('maps a row to { t: iso, group, value: number } (no state from toPoints)', () => {
      const rows = [
        { bucket: new Date('2026-09-29T10:00:00.000Z'), group: 'gpt-4', value: '42' },
      ];
      const result = toPoints(rows);
      expect(result).toEqual([
        { t: '2026-09-29T10:00:00.000Z', group: 'gpt-4', value: 42 },
      ]);
      expect(result[0].state).toBeUndefined();
    });

    it('coerces a null value to 0 (idle -> 0 boundary rule)', () => {
      const rows = [
        { bucket: new Date('2026-09-29T10:00:00.000Z'), group: 'gpt-4', value: null },
      ];
      expect(toPoints(rows)).toEqual([
        { t: '2026-09-29T10:00:00.000Z', group: 'gpt-4', value: 0 },
      ]);
    });

    it('passes a numeric value through unchanged', () => {
      const rows = [
        { bucket: new Date('2026-09-29T10:00:00.000Z'), group: 'gpt-4', value: 123.5 },
      ];
      expect(toPoints(rows)).toEqual([
        { t: '2026-09-29T10:00:00.000Z', group: 'gpt-4', value: 123.5 },
      ]);
    });

    it('maps every row, preserving order (the handler maps row[group] -> group first)', () => {
      const rows = [
        { bucket: new Date('2026-09-29T10:00:00.000Z'), group: 'a', value: '1' },
        { bucket: new Date('2026-09-29T10:05:00.000Z'), group: 'b', value: null },
      ];
      expect(toPoints(rows)).toEqual([
        { t: '2026-09-29T10:00:00.000Z', group: 'a', value: 1 },
        { t: '2026-09-29T10:05:00.000Z', group: 'b', value: 0 },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration — fake QueryFn + real node:http server on an ephemeral port
// ---------------------------------------------------------------------------

describe('server — integration (fake QueryFn, real http server, no live DB)', () => {
  let fakeQuery: FakeQuery;
  let server: { base: string; close: () => Promise<void> };

  beforeEach(async () => {
    fakeQuery = makeFakeQuery();
    server = await startServer(fakeQuery);
  });

  afterEach(async () => {
    await server.close();
  });

  describe('GET /api/series — valid queries', () => {
    it('returns a healthy point series for requests/1h/model', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      // fake rows use the group column name (`model`), not a `group` key
      fakeQuery.mockResolvedValue({ rows: [{ bucket, model: 'gpt-4', value: '10' }] });

      const { status, body } = await getSeries(server.base, 'metric=requests&range=1h&group=model');

      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({ t: '2026-09-29T10:00:00.000Z', group: 'gpt-4', value: 10 });

      expect(fakeQuery).toHaveBeenCalledTimes(6);
      const [sql, params] = firstCall(fakeQuery);
      expect(sql).toContain('requests_1m');
      expect(sql).toContain('SUM(sum_value)');
      expect(params).toEqual([3600]);
    });

    it('returns a healthy point series for latency/24h/api_provider (avg_value)', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      fakeQuery.mockResolvedValue({ rows: [{ bucket, api_provider: 'openai', value: '123.5' }] });

      const { status, body } = await getSeries(
        server.base,
        'metric=latency&range=24h&group=api_provider',
      );

      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({ t: '2026-09-29T10:00:00.000Z', group: 'openai', value: 123.5 });

      expect(fakeQuery).toHaveBeenCalledTimes(5);
      const [sql, params] = firstCall(fakeQuery);
      expect(sql).toContain('latency_5m');
      expect(sql).toContain('avg_value');
      expect(params).toEqual([86400]);
    });

    it('returns an empty series for the errors metric and never queries the DB', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { status, body } = await getSeries(
        server.base,
        'metric=errors&range=1h&group=model',
      );

      expect(status).toBe(200);
      expect(body).toEqual([]);
      expect(fakeQuery).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('errors metric has no DB backing'))).toBe(true);

      warnSpy.mockRestore();
    });
  });

  describe('GET /api/series — invalid queries (400)', () => {
    it('returns 400 with an error for an unknown metric', async () => {
      const { status, body } = await getSeries(server.base, 'metric=bogus&range=1h&group=model');
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
      expect(fakeQuery).not.toHaveBeenCalled();
    });

    it('returns 400 with an error for an unknown range', async () => {
      const { status, body } = await getSeries(server.base, 'metric=requests&range=30d&group=model');
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
      expect(fakeQuery).not.toHaveBeenCalled();
    });

    it('returns 400 with an error when the group is missing', async () => {
      const { status, body } = await getSeries(server.base, 'metric=requests&range=1h');
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
      expect(fakeQuery).not.toHaveBeenCalled();
    });
  });

  describe('unknown routes (404)', () => {
    it('returns 404 with an error for an unknown path', async () => {
      const { status, body } = await get(server.base, '/api/unknown');
      expect(status).toBe(404);
      expect(typeof body.error).toBe('string');
    });
  });
});

// ---------------------------------------------------------------------------
// Reference constants — cross-checked, to guard the exported surface
// ---------------------------------------------------------------------------

describe('exported reference constants', () => {
  it('exposes the documented range → tier map', () => {
    expect(TIER_MAP).toEqual({ '1h': '1m', '24h': '5m', '7d': '1h' });
  });
  it('exposes the documented range → seconds map', () => {
    expect(RANGE_SECONDS).toEqual({ '1h': 3600, '24h': 86400, '7d': 604800 });
  });
});

// ---------------------------------------------------------------------------
// Deployment health state (deployment_health table) — real state, no faking
// ---------------------------------------------------------------------------

describe('deployment health state', () => {
  describe('buildHealthSql — SQL construction', () => {
    it('selects the latest health row per (model_id, litellm_model_name) in the look-back window', () => {
      const sql = buildHealthSql();
      expect(sql).toContain('FROM deployment_health');
      expect(sql).toContain('DISTINCT ON (model_id, litellm_model_name)');
      expect(sql).toContain("ts >= now() - ($1 * interval '1 second')");
      expect(sql).toContain('ORDER BY model_id, litellm_model_name, ts DESC');
    });
  });

  describe('buildStateByGroup — health rows → group state map', () => {
    it('maps a row to both model_id and litellm_model_name keys', () => {
      const rows = [
        { model_id: 'gpt-4', litellm_model_name: 'gpt-4-prod', status: 'error' },
      ];
      const map = buildStateByGroup(rows);
      expect(map.get('gpt-4')).toBe('error');
      expect(map.get('gpt-4-prod')).toBe('error');
    });

    it('maps unknown/other status values to "error"', () => {
      const rows = [
        { model_id: 'gpt-4', litellm_model_name: 'gpt-4-prod', status: 'other-value' },
      ];
      const map = buildStateByGroup(rows);
      expect(map.get('gpt-4')).toBe('error');
      expect(map.get('gpt-4-prod')).toBe('error');
    });

    it('ignores rows whose status is null (the key is absent)', () => {
      const rows = [
        { model_id: 'gpt-4', litellm_model_name: 'gpt-4-prod', status: null },
      ];
      const map = buildStateByGroup(rows);
      expect(map.get('gpt-4')).toBeUndefined();
      expect(map.get('gpt-4-prod')).toBeUndefined();
    });

    it('keeps the worst state when a group appears with several states', () => {
      const base = [
        { model_id: 'm1', litellm_model_name: 'a', status: 'healthy' },
        { model_id: 'm1', litellm_model_name: 'b', status: 'prefill' },
      ];
      expect(buildStateByGroup(base).get('m1')).toBe('prefill');

      const withError = [
        ...base,
        { model_id: 'm1', litellm_model_name: 'c', status: 'error' },
      ];
      expect(buildStateByGroup(withError).get('m1')).toBe('error');
    });
  });

  describe('GET /api/series — deployment health integration', () => {
    it('serves a real error state from deployment_health', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      const q = makeDispatchingQuery(
        [{ bucket, model: 'gpt-4', value: '10' }],
        [{ model_id: 'gpt-4', litellm_model_name: 'gpt-4-prod', status: 'error' }],
      );
      const srv = await startServer(q);
      try {
        const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0].state).toBe('error');
        expect(body[0].value).toBe(10);
      } finally {
        await srv.close();
      }
    });

    it('serves per-group state across mixed groups (healthy + error)', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      const q = makeDispatchingQuery(
        [
          { bucket, model: 'gpt-4', value: '10' },
          { bucket, model: 'claude-3', value: '20' },
        ],
        [
          { model_id: 'gpt-4', litellm_model_name: 'gpt-4-prod', status: 'healthy' },
          { model_id: 'claude-3', litellm_model_name: 'claude-3-prod', status: 'error' },
        ],
      );
      const srv = await startServer(q);
      try {
        const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body).toHaveLength(2);
        const gpt = body.find((p: any) => p.group === 'gpt-4');
        const claude = body.find((p: any) => p.group === 'claude-3');
        expect(gpt.state).toBe('healthy');
        expect(claude.state).toBe('error');
      } finally {
        await srv.close();
      }
    });

    it('serves the worst state when two deployments map to one group', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      const valueRows = [{ bucket, model: 'm1', value: '10' }];

      const q1 = makeDispatchingQuery(valueRows, [
        { model_id: 'm1', litellm_model_name: 'dep-a', status: 'healthy' },
        { model_id: 'm1', litellm_model_name: 'dep-b', status: 'prefill' },
      ]);
      const srv1 = await startServer(q1);
      try {
        const { status, body } = await getSeries(srv1.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body[0].state).toBe('prefill');
      } finally {
        await srv1.close();
      }

      const q2 = makeDispatchingQuery(valueRows, [
        { model_id: 'm1', litellm_model_name: 'dep-a', status: 'healthy' },
        { model_id: 'm1', litellm_model_name: 'dep-b', status: 'error' },
      ]);
      const srv2 = await startServer(q2);
      try {
        const { status, body } = await getSeries(srv2.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body[0].state).toBe('error');
      } finally {
        await srv2.close();
      }
    });

    it('tolerates a missing deployment_health table (state undefined, still 200)', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      const valueRows = [{ bucket, model: 'gpt-4', value: '10' }];
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const q = vi.fn(async (sql: string, _params: unknown[]) => {
        if (sql.includes('deployment_health')) {
          throw new Error('relation "deployment_health" does not exist');
        }
        return { rows: valueRows };
      }) as unknown as FakeQuery;
      const srv = await startServer(q);
      try {
        const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0]).toEqual({ t: '2026-09-29T10:00:00.000Z', group: 'gpt-4', value: 10 });
        expect(body[0].state).toBeUndefined();
      } finally {
        await srv.close();
        warnSpy.mockRestore();
      }
    });

    it('serves state undefined when the deployment_health table is empty', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      const q = makeDispatchingQuery(
        [{ bucket, model: 'gpt-4', value: '10' }],
        [],
      );
      const srv = await startServer(q);
      try {
        const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0].state).toBeUndefined();
      } finally {
        await srv.close();
      }
    });

    it('maps request-side labels to deployment-side state through the model_id bridge (live bug repro)', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      const q = makeDispatchingQuery(
        [
          { bucket, model: 'orchestration', value: '10' },
          { bucket, model: '', value: '5' },
        ],
        [{ model_id: 'mid-1', litellm_model_name: 'orchestration-qwen38', status: 'error' }],
        [{ label: 'orchestration', model_id: 'mid-1' }],
      );
      const srv = await startServer(q);
      try {
        const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body).toHaveLength(2);
        // The request-side label 'orchestration' never appears in the health rows —
        // state is derived generically via the model_id bridge.
        expect(body[0].state).toBe('error');
        expect(body[0].value).toBe(10);
        expect(body[1].state).toBeUndefined();

        // The bridge query was issued with the range seconds bound as its only param.
        const bridgeCall = q.mock.calls.find((c: [string, unknown[]]) => c[0].includes('AS label'));
        expect(bridgeCall).toBeDefined();
        expect(bridgeCall![1]).toEqual([3600]);
      } finally {
        await srv.close();
      }
    });

    it('attaches state for a group whose label equals the model_id without needing the bridge', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      const q = makeDispatchingQuery(
        [{ bucket, model: 'mid-9', value: '10' }],
        [{ model_id: 'mid-9', litellm_model_name: 'other', status: 'healthy' }],
        [],
      );
      const srv = await startServer(q);
      try {
        const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0].state).toBe('healthy');
      } finally {
        await srv.close();
      }
    });

    it('degrades gracefully when the bridge query fails (still 200, direct lookup only)', async () => {
      const bucket = new Date('2026-09-29T10:00:00.000Z');
      const valueRows = [
        { bucket, model: 'gpt-4', value: '10' },
        { bucket, model: 'orchestration', value: '7' },
      ];
      const health = [{ model_id: 'gpt-4', litellm_model_name: 'gpt-4-prod', status: 'error' }];
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const q = vi.fn(async (sql: string, _params: unknown[]) => {
        if (sql.includes('AS label')) throw new Error('bridge table missing');
        if (sql.includes('deployment_health')) return { rows: health };
        return { rows: valueRows };
      }) as unknown as FakeQuery;
      const srv = await startServer(q);
      try {
        const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
        expect(status).toBe(200);
        expect(body).toHaveLength(2);
        const gpt = body.find((p: any) => p.group === 'gpt-4');
        const orch = body.find((p: any) => p.group === 'orchestration');
        // Direct lookup survived: the label happens to equal a model_id key.
        expect(gpt.state).toBe('error');
        // Bridge gone → unresolvable, never fabricated.
        expect(orch.state).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        await srv.close();
        warnSpy.mockRestore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// buildBridgeSql — request-label → model_id bridge SQL
// ---------------------------------------------------------------------------

describe('buildBridgeSql — request-label → model_id bridge SQL', () => {
  it('returns the exact bridge SQL for requests grouped by model', () => {
    expect(buildBridgeSql('requests', 'model')).toBe(
      "SELECT DISTINCT model AS label, model_id FROM requests WHERE model_id IS NOT NULL AND model IS NOT NULL AND ts >= now() - ($1 * interval '1 second')",
    );
  });

  it.each(['requests', 'spend', 'tokens', 'latency'] as const)(
    'reads from the %s table with no tier suffix or deployment_health',
    (metric) => {
      const sql = buildBridgeSql(metric, 'model');
      expect(sql).toContain(`FROM ${metric} `);
      expect(sql).not.toMatch(/_\d+[mh]\b/);
      expect(sql).not.toContain('deployment_health');
    },
  );

  it('groups by the group column it is given (api_provider)', () => {
    const sql = buildBridgeSql('tokens', 'api_provider');
    expect(sql).toContain('SELECT DISTINCT api_provider AS label, model_id');
    expect(sql).toContain('AND api_provider IS NOT NULL');
  });

  it('binds the look-back window to $1 and never interpolates raw seconds', () => {
    const sql = buildBridgeSql('requests', 'model');
    expect(sql).toContain("$1 * interval '1 second'");
    expect(sql).not.toMatch(/\b(3600|86400|60|36000)\b/);
  });
});

// ---------------------------------------------------------------------------
// buildLabelToModelIds — bridge rows → label → model_id[] map
// ---------------------------------------------------------------------------

describe('buildLabelToModelIds — bridge rows → label → model_id[] map', () => {
  it('returns an empty map for empty input', () => {
    const map = buildLabelToModelIds([]);
    expect(map.size).toBe(0);
  });

  it('groups one label to several model_ids, preserving first-seen order', () => {
    const rows = [
      { label: 'a', model_id: 'm1' },
      { label: 'a', model_id: 'm2' },
      { label: 'b', model_id: 'm3' },
    ] as BridgeRow[];
    const map = buildLabelToModelIds(rows);
    expect(map.get('a')).toEqual(['m1', 'm2']);
    expect(map.get('b')).toEqual(['m3']);
  });

  it('dedupes repeated (label, model_id) pairs', () => {
    const rows = [
      { label: 'a', model_id: 'm1' },
      { label: 'a', model_id: 'm1' },
      { label: 'a', model_id: 'm2' },
    ] as BridgeRow[];
    const map = buildLabelToModelIds(rows);
    expect(map.get('a')).toEqual(['m1', 'm2']);
    expect(map.get('a')).toHaveLength(2);
  });

  it('skips rows with a null or undefined label or model_id', () => {
    const rows = [
      { label: null, model_id: 'm1' } as BridgeRow,
      { label: 'a', model_id: null } as BridgeRow,
      { label: null, model_id: null } as BridgeRow,
      { label: 'a', model_id: undefined } as unknown as BridgeRow,
      { label: 'b', model_id: 'm2' },
    ] as BridgeRow[];
    const map = buildLabelToModelIds(rows);
    expect([...map.keys()]).toEqual(['b']);
    expect(map.get('b')).toEqual(['m2']);
    expect(map.get('a')).toBeUndefined();
  });

  it('coerces non-string label and model_id values with String()', () => {
    const rows = [{ label: 1, model_id: 2 } as unknown as BridgeRow] as BridgeRow[];
    const map = buildLabelToModelIds(rows);
    expect(map.get('1')).toEqual(['2']);
  });

  it('returns a real Map', () => {
    expect(buildLabelToModelIds([])).toBeInstanceOf(Map);
  });
});

// ---------------------------------------------------------------------------
// attachStates — request label → deployment state via the bridge map
// ---------------------------------------------------------------------------

describe('attachStates — request label → deployment state via the bridge map', () => {
  it('resolves through the bridge: label maps to model_id, which has a state', () => {
    const stateByGroup = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'deploy-a', status: 'error' },
    ]);
    const labelToModelIds = new Map<string, string[]>([['req-label', ['mid-1']]]);
    const points: SeriesPoint[] = [{ t: '2026-09-29T10:00:00.000Z', group: 'req-label', value: 10 }];

    const out = attachStates(points, stateByGroup, labelToModelIds);

    expect(out[0].state).toBe('error');
  });

  it('direct-label fallback still works when the bridge map is empty', () => {
    const stateByGroup = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'deploy-a', status: 'error' },
    ]);
    const labelToModelIds = new Map<string, string[]>();
    const points: SeriesPoint[] = [{ t: '2026-09-29T10:00:00.000Z', group: 'deploy-a', value: 10 }];

    const out = attachStates(points, stateByGroup, labelToModelIds);

    expect(out[0].state).toBe('error');
  });

  it('worst-state-wins across several model_ids for one label (order-independent)', () => {
    const stateByGroup = new Map<string, DeploymentState>([
      ['mid-1', 'healthy'],
      ['mid-2', 'error'],
    ]);

    // Forward order
    let labelToModelIds = new Map<string, string[]>([['req-label', ['mid-1', 'mid-2']]]);
    let points: SeriesPoint[] = [{ t: '2026-09-29T10:00:00.000Z', group: 'req-label', value: 10 }];
    let out = attachStates(points, stateByGroup, labelToModelIds);
    expect(out[0].state).toBe('error');

    // Reversed candidate order
    labelToModelIds = new Map<string, string[]>([['req-label', ['mid-2', 'mid-1']]]);
    points = [{ t: '2026-09-29T10:00:00.000Z', group: 'req-label', value: 10 }];
    out = attachStates(points, stateByGroup, labelToModelIds);
    expect(out[0].state).toBe('error');

    // Healthy + prefill pair → prefill
    const stateByGroup2 = new Map<string, DeploymentState>([
      ['mid-1', 'healthy'],
      ['mid-2', 'prefill'],
    ]);
    labelToModelIds = new Map<string, string[]>([['req-label', ['mid-1', 'mid-2']]]);
    points = [{ t: '2026-09-29T10:00:00.000Z', group: 'req-label', value: 10 }];
    out = attachStates(points, stateByGroup2, labelToModelIds);
    expect(out[0].state).toBe('prefill');
  });

  it('candidates absent from stateByGroup are ignored, not fatal', () => {
    const stateByGroup = new Map<string, DeploymentState>([['mid-1', 'healthy']]);
    const labelToModelIds = new Map<string, string[]>([['req-label', ['ghost']]]);
    const points: SeriesPoint[] = [{ t: '2026-09-29T10:00:00.000Z', group: 'mid-1', value: 10 }];

    const out = attachStates(points, stateByGroup, labelToModelIds);

    // The point's own group 'mid-1' resolves directly; 'ghost' is absent and ignored.
    expect(out[0].state).toBe('healthy');
  });

  it('unresolved → state stays undefined (never fabricated)', () => {
    const stateByGroup = new Map<string, DeploymentState>();
    const labelToModelIds = new Map<string, string[]>();
    const points: SeriesPoint[] = [{ t: '2026-09-29T10:00:00.000Z', group: 'nowhere', value: 10 }];

    const out = attachStates(points, stateByGroup, labelToModelIds);

    expect(out[0].state).toBeUndefined();
    expect('state' in out[0]).toBe(false);
  });

  it('mutates points in place AND returns the same array (identity)', () => {
    const stateByGroup = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'deploy-a', status: 'error' },
    ]);
    const labelToModelIds = new Map<string, string[]>([['req-label', ['mid-1']]]);
    const points: SeriesPoint[] = [
      { t: '2026-09-29T10:00:00.000Z', group: 'req-label', value: 10 },
      { t: '2026-09-29T10:05:00.000Z', group: 'deploy-a', value: 20 },
    ];

    const out = attachStates(points, stateByGroup, labelToModelIds);

    expect(out).toBe(points);
    expect(points[0].state).toBe('error');
    expect(points[1].state).toBe('error');
  });

  it('mixed batch: bridge-resolved, direct, and unresolved in one call', () => {
    const stateByGroup = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'deploy-a', status: 'error' },
      { model_id: 'mid-2', litellm_model_name: 'deploy-b', status: 'healthy' },
    ]);
    const labelToModelIds = new Map<string, string[]>([['req-label', ['mid-1']]]);
    const points: SeriesPoint[] = [
      { t: '2026-09-29T10:00:00.000Z', group: 'req-label', value: 10 },
      { t: '2026-09-29T10:05:00.000Z', group: 'mid-2', value: 20 },
      { t: '2026-09-29T10:10:00.000Z', group: 'nowhere', value: 30 },
    ];

    const out = attachStates(points, stateByGroup, labelToModelIds);

    expect(out[0].state).toBe('error');
    expect(out[1].state).toBe('healthy');
    expect(out[2].state).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// server.ts source guard — no hardcoded production name maps
// ---------------------------------------------------------------------------

describe('server.ts source guard — no hardcoded production name maps', () => {
  const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

  const forbidden = ['orchestration', 'vision-tools', 'qwen', 'tools'];

  for (const name of forbidden) {
    it(`does not contain the hardcoded production name '${name}'`, () => {
      expect(src).not.toContain(name);
    });
  }

  it('contains buildBridgeSql (positive control: the file was actually read)', () => {
    expect(src).toContain('buildBridgeSql');
  });

  it("contains 'model_id IS NOT NULL' (positive control: bridge SQL exists)", () => {
    expect(src).toContain('model_id IS NOT NULL');
  });
});

// ---------------------------------------------------------------------------
// Derived metric surface — METRICS/GROUPS/DERIVED/isDerivedMetric/valueColumn
// (the API is the single derivation point; no rate math in the browser;
//  rate/increase math is consumer-side, never scraper-made)
// ---------------------------------------------------------------------------

describe('derived metric surface', () => {
  it('METRICS includes the three derived metrics and keeps the original five', () => {
    expect(METRICS).toContain('decode_tps');
    expect(METRICS).toContain('input_tps');
    expect(METRICS).toContain('decode_tps_implied');
    for (const m of ['requests', 'errors', 'spend', 'tokens', 'latency']) {
      expect(METRICS).toContain(m);
    }
  });

  it('METRICS includes the fleet-aggregate output rate', () => {
    expect(METRICS).toContain('aggregate_output_tps');
  });

  it('METRICS includes the per-request wall-clock metric', () => {
    expect(METRICS).toContain('request_wall_clock');
  });

  it('GROUPS includes model_id (additive) and keeps model/api_provider', () => {
    expect(GROUPS).toContain('model_id');
    expect(GROUPS).toContain('model');
    expect(GROUPS).toContain('api_provider');
  });

  it('isDerivedMetric is true for the three derived metrics', () => {
    expect(isDerivedMetric('decode_tps')).toBe(true);
    expect(isDerivedMetric('input_tps')).toBe(true);
    expect(isDerivedMetric('decode_tps_implied')).toBe(true);
  });

  it('isDerivedMetric is false for the table-backed metrics', () => {
    expect(isDerivedMetric('requests')).toBe(false);
    expect(isDerivedMetric('tokens')).toBe(false);
    expect(isDerivedMetric('errors')).toBe(false);
  });

  it('valueColumn is undefined for the derived metrics (not cagg-backed)', () => {
    expect(valueColumn('decode_tps')).toBeUndefined();
    expect(valueColumn('input_tps')).toBeUndefined();
    expect(valueColumn('decode_tps_implied')).toBeUndefined();
  });

  it('DERIVED declares unit token/s and the whitelisted source tables', () => {
    expect(DERIVED.decode_tps.unit).toBe('token/s');
    expect(DERIVED.decode_tps.num.table).toBe('output_tokens');
    // Decode speed divides by DECODE seconds (upstream latency minus TTFT), not
    // the bucket's wall-clock seconds — wall-clock gave average throughput incl.
    // idle/queue/prefill time.
    expect(DERIVED.decode_tps.den).toEqual({
      kind: 'series_diff',
      source: { table: 'latency', metric: 'litellm_llm_api_latency_metric_sum' },
      minus: { table: 'latency', metric: 'litellm_llm_api_time_to_first_token_metric_sum' },
    });
    expect(DERIVED.input_tps.num.table).toBe('input_tokens');
    expect(DERIVED.input_tps.den).toEqual({ kind: 'bucket_seconds' });
    expect(DERIVED.decode_tps_implied.num).toEqual({
      table: 'latency',
      metric: 'litellm_deployment_latency_per_output_token_count',
    });
    expect(DERIVED.decode_tps_implied.den).toEqual({
      kind: 'series',
      source: { table: 'latency', metric: 'litellm_deployment_latency_per_output_token_sum' },
    });
  });

  it('DERIVED_BUCKET_SECONDS maps each tier to its wall-clock seconds', () => {
    expect(DERIVED_BUCKET_SECONDS['1m']).toBe(60);
    expect(DERIVED_BUCKET_SECONDS['5m']).toBe(300);
    expect(DERIVED_BUCKET_SECONDS['1h']).toBe(3600);
  });

  it('DERIVED_INTERVAL maps each tier to its exact interval literal', () => {
    expect(DERIVED_INTERVAL['1m']).toBe("INTERVAL '1 minute'");
    expect(DERIVED_INTERVAL['5m']).toBe("INTERVAL '5 minutes'");
    expect(DERIVED_INTERVAL['1h']).toBe("INTERVAL '1 hour'");
  });
});

// ---------------------------------------------------------------------------
// buildDerivedSql — raw hypertable counter SQL (never a ${metric}_${tier} cagg)
// ---------------------------------------------------------------------------

describe('buildDerivedSql — raw hypertable SUM(value) SQL (columns are pre-deltaed)', () => {
  it('decode_tps sums output_tokens per bucket over the bucket decode seconds', () => {
    const sql = buildDerivedSql('decode_tps', '1m', 'model_id');
    expect(sql).toContain('FROM output_tokens');
    expect(sql).toContain('time_bucket(');
    expect(sql).toContain("time_bucket(INTERVAL '1 minute', ts)");
    expect(sql).toContain('SUM(value)');
    // FIX (P2): no zero-drop. An all-zero bucket must survive so the roster grid
    // can render it as a real 0 instead of a gap.
    expect(sql).not.toContain('HAVING');
    // Denominator: Σ llm_api_latency_sum − Σ TTFT_sum per bucket, one pass over
    // latency, LEFT-joined so idle buckets keep their roster row.
    expect(sql).not.toContain('60 AS den');
    expect(sql).toContain('d.v AS den');
    expect(sql).toContain('LEFT JOIN dagg d');
    expect(sql).toContain("SUM(value) FILTER (WHERE metric = 'litellm_llm_api_latency_metric_sum')");
    expect(sql).toContain(
      "COALESCE(SUM(value) FILTER (WHERE metric = 'litellm_llm_api_time_to_first_token_metric_sum'), 0)",
    );
    expect(sql).toContain('$1');
    // FIX (P2/P3): the row set is the roster UNION the metric-only groups
    // (`allgroups g`), so the emitted group column comes from `g.grp`, not from
    // the metric CTE.
    expect(sql).toContain('CROSS JOIN allgroups g');
    expect(sql).toContain('g.grp AS model_id');
    expect(sql).toContain('AS num');
    expect(sql).toContain('AS den');
    // FIX 2: NO delta-of-delta — the raw column is already a per-scrape delta,
    // so there is no LAG, no prev_value, no re-differencing, no SUM(dt).
    expect(sql).not.toContain('LAG(');
    expect(sql).not.toContain('SUM(dt)');
    expect(sql).not.toContain('delta');
    // no cagg-style table for a derived metric
    expect(sql).not.toContain('decode_tps_1m');
    expect(sql).not.toMatch(/decode_tps_\d+[mh]/);
  });

  it('input_tps sums input_tokens per bucket (no TTFT denominator)', () => {
    const sql = buildDerivedSql('input_tps', '1m', 'model_id');
    expect(sql).toContain('FROM input_tokens');
    expect(sql).toContain('SUM(value)');
    expect(sql).toContain('60 AS den');
    expect(sql).not.toContain('LAG(');
    expect(sql).not.toContain('SUM(dt)');
    // FIX 2: prefill no longer divides by the TTFT latency series at all.
    expect(sql).not.toContain('latency');
    expect(sql).not.toContain('input_tps_1m');
  });

  it('decode_tps_implied divides the per-output-token _count by the _sum (both SUM(value))', () => {
    const sql = buildDerivedSql('decode_tps_implied', '1m', 'model_id');
    expect(sql).toContain('FROM latency');
    expect(sql).toContain("metric = 'litellm_deployment_latency_per_output_token_count'");
    expect(sql).toContain("metric = 'litellm_deployment_latency_per_output_token_sum'");
    expect(sql).toContain('SUM(value)');
    expect(sql).not.toContain('LAG(');
    expect(sql).not.toContain('decode_tps_implied_1m');
  });

  it.each([
    ['1m', "INTERVAL '1 minute'"],
    ['5m', "INTERVAL '5 minutes'"],
    ['1h', "INTERVAL '1 hour'"],
  ])('uses the exact interval literal for tier %s', (tier, lit) => {
    expect(buildDerivedSql('decode_tps', tier, 'model_id')).toContain(lit);
  });

  it('groups by the requested group column (model)', () => {
    const sql = buildDerivedSql('decode_tps', '5m', 'model');
    // FIX (P2/P3): axis `model` rosters on deployment_inventory.model_group, so
    // the emitted group column is `g.grp AS model` (allgroups = roster UNION
    // metric-only groups) while the metric CTE still groups by the hypertable's
    // own `model` column and joins back on it.
    expect(sql).toContain('SELECT DISTINCT model_group AS grp FROM deployment_inventory');
    expect(sql).toContain('g.grp AS model');
    expect(sql).toContain('LEFT JOIN nagg n ON n.bucket = b.bucket AND n.model = g.grp');
    expect(sql).toContain('GROUP BY bucket, model');
  });

  it('rejects an unknown group before interpolating', () => {
    expect(() => buildDerivedSql('decode_tps', '1m', 'user')).toThrow();
  });

  it('allgroups collapses to ONE row per group (bool_or flag), never two — the 2x max-tile dup bug', () => {
    // FIX (2x dup): a bare `roster UNION (SELECT DISTINCT grp, false FROM nagg)`
    // dedupes on the whole row (grp, inv), so every deployment that is both
    // inventoried AND emitting metrics got two allgroups rows — (grp, true) and
    // (grp, false) — and the buckets CROSS JOIN emitted two identical points per
    // (bucket, group). Summing the raw series per bucket (the web's
    // maxCombinedTokenRate) then double-counted every deployment: measured 2.000x
    // on the "Max Combined Token/s (ever)" tile and on input_tps.
    const sql = buildDerivedSql('decode_tps', '1m', 'model_id');
    expect(sql).toContain('allgroups AS (SELECT grp, bool_or(inv) AS inv FROM (');
    expect(sql).toContain(') branches GROUP BY grp)');
    // the flag semantics stay: rostered -> true, metric-only -> false
    expect(sql).toContain('SELECT grp, true AS inv FROM roster');
    expect(sql).toContain('UNION ALL SELECT DISTINCT n.model_id AS grp, false AS inv FROM nagg n');
    // and no bare union-of-flags survives anywhere
    expect(sql).not.toContain('UNION SELECT DISTINCT n.');
  });

  it('decode_tps gates the TTFT estimate on the classifier verdict (axis-bound join)', () => {
    const sql = buildDerivedSql('decode_tps', '1m', 'model_id');
    expect(sql).toContain(
      "LEFT JOIN ttft_classification c ON c.axis = 'model_id' AND c.grp = d.model_id",
    );
    expect(sql).toContain('CASE WHEN c.corrected');
    // the correction is measured by the classifier, not compared per request
    expect(sql).not.toContain('c.share >');
    // the per-bucket estimate pieces are present (base / ttft_n / est)
    expect(sql).toContain(' AS base, ');
    expect(sql).toContain(' AS est ');
  });

  it('aggregate_output_tps divides output tokens by the bucket WALL-CLOCK seconds (no TTFT term)', () => {
    const sql = buildDerivedSql('aggregate_output_tps', '1m', 'model_id');
    expect(sql).toContain('FROM output_tokens');
    expect(sql).toContain('SUM(value)');
    expect(sql).toContain('60 AS den');
    // the aggregate never touches latency/TTFT or the classifier table
    expect(sql).not.toContain('latency');
    expect(sql).not.toContain('time_to_first_token');
    expect(sql).not.toContain('ttft_classification');
  });

  it('request_wall_clock divides total request latency by the request COUNT (mean seconds)', () => {
    const sql = buildDerivedSql('request_wall_clock', '1m', 'model_id');
    expect(sql).toContain('FROM latency');
    expect(sql).toContain("metric = 'litellm_request_total_latency_metric_sum'");
    expect(sql).toContain("metric = 'litellm_request_total_latency_metric_count'");
    expect(sql).toContain('d.v AS den');
    // a series denominator, not a constant bucket-seconds one
    expect(sql).not.toContain('60 AS den');
    // nothing rate-shaped here: no TTFT correction, no classifier join
    expect(sql).not.toContain('time_to_first_token');
    expect(sql).not.toContain('ttft_classification');
  });

  it('rejects an unknown tier before interpolating', () => {
    expect(() => buildDerivedSql('decode_tps', '30m', 'model_id')).toThrow();
  });

  it('rejects a non-derived metric', () => {
    expect(() => buildDerivedSql('requests', '1m', 'model_id')).toThrow();
  });

  // FIX 2 regression: the raw hypertable columns are ALREADY differenced by the
  // scraper (delta.go). Re-differencing them (LAG / prev_value / SUM(dt)) is the
  // delta-of-delta bug that inflated decode/prefill tps ~4x. None may appear.
  it.each(['decode_tps', 'input_tps', 'decode_tps_implied'])(
    'no LAG on pre-deltaed columns: %s',
    (metric) => {
      const sql = buildDerivedSql(metric, '1m', 'model_id');
      expect(sql).not.toMatch(/LAG\(/);
      expect(sql).not.toContain('prev_value');
      expect(sql).not.toContain('SUM(dt)');
    },
  );
});

// ---------------------------------------------------------------------------
// TTFT/ghost classifier — per-backend verdicts (threshold via docker env)
// ---------------------------------------------------------------------------

describe('TTFT/ghost classifier', () => {
  it('parseEnvNumber: unset/empty/non-numeric/negative fall back, 0 and positives pass', () => {
    expect(parseEnvNumber(undefined, 7)).toBe(7);
    expect(parseEnvNumber('', 7)).toBe(7);
    expect(parseEnvNumber('abc', 7)).toBe(7);
    expect(parseEnvNumber('-3', 7)).toBe(7);
    expect(parseEnvNumber('0', 7)).toBe(0);
    expect(parseEnvNumber('300', 7)).toBe(300);
  });

  it('parseThresholdPct defaults to 2 and accepts 0 / large values', () => {
    expect(parseThresholdPct(undefined)).toBe(2);
    expect(parseThresholdPct('nope')).toBe(2);
    expect(parseThresholdPct('-1')).toBe(2);
    expect(parseThresholdPct('0')).toBe(0);
    expect(parseThresholdPct('2.5')).toBe(2.5);
    expect(parseThresholdPct('1000000')).toBe(1000000);
  });

  it('buildTtftClassifierSql classifies both inventory axes with $1 window and $2 threshold', () => {
    for (const axis of TTFT_CLASSIFIER_AXES) {
      const sql = buildTtftClassifierSql(axis, 86400, 2);
      expect(sql).toContain('INSERT INTO ttft_classification');
      expect(sql).toContain(`SELECT '${axis}'`);
      expect(sql).toContain("FROM latency WHERE ts >= now() - ($1 * interval '1 second')");
      expect(sql).toContain("litellm_llm_api_latency_metric_sum");
      expect(sql).toContain("litellm_llm_api_time_to_first_token_metric_sum");
      expect(sql).toContain("litellm_llm_api_latency_metric_count");
      expect(sql).toContain("litellm_llm_api_time_to_first_token_metric_count");
      // real-hardware verdict needs a rostered endpoint; ghosts get a reason
      expect(sql).toContain("COALESCE(i.api_base, '') <> ''");
      expect(sql).toContain("'metric-only: no deployment_inventory row'");
      expect(sql).toContain("'inventory row without api_base'");
      // corrected = real_hw AND share_pct > threshold
      expect(sql).toContain('(s.real_hw AND s.share_pct IS NOT NULL AND s.share_pct > $2)');
    }
  });

  it('buildTtftClassifierSql rejects axes without an inventory column', () => {
    expect(() => buildTtftClassifierSql('api_provider', 3600, 2)).toThrow();
    expect(() => buildTtftClassifierSql('user', 3600, 2)).toThrow();
  });

  it('inventoryFingerprint hashes identity columns so a new/updated model changes it', async () => {
    const seen: string[] = [];
    let row = { n: 2, fp: 'abc' };
    const query = (sql: string) => {
      seen.push(sql);
      return Promise.resolve({ rows: [row] });
    };
    expect(await inventoryFingerprint(query)).toBe('2:abc');
    row = { n: 3, fp: 'def' };
    expect(await inventoryFingerprint(query)).toBe('3:def');
    expect(seen[0]).toContain('deployment_inventory');
    expect(seen[0]).toContain('md5');
  });
});

// ---------------------------------------------------------------------------
// derivedPoints — the testable rate math (omit idle, never a fake 0)
// ---------------------------------------------------------------------------

describe('derivedPoints — rate math, omit idle (never a fake 0)', () => {
  const B = '2026-09-29T10:00:00.000Z';
  const row = (num: unknown, den: unknown): DerivedRow => ({ bucket: B, group: 'm1', num, den });

  it('decode_tps: num=600 / den=60 -> 10 token/s', () => {
    expect(derivedPoints([row(600, 60)], 'model_id')).toEqual([
      { t: B, group: 'm1', value: 10, unit: 'token/s' },
    ]);
  });

  it('wall-clock rows pass the spec unit through (s, not token/s)', () => {
    const pts = derivedPoints([row(300, 10)], 'model_id', 's');
    expect(pts[0].value).toBe(30);
    expect(pts[0].unit).toBe('s');
  });

  it('input_tps: input 1200 / ttft 4 -> 300 (TTFT division)', () => {
    const pts = derivedPoints([row(1200, 4)], 'model_id');
    expect(pts[0].value).toBe(300);
    expect(pts[0].unit).toBe('token/s');
  });

  it('coerces numeric strings from pg', () => {
    expect(derivedPoints([row('600', '60')], 'model_id')[0].value).toBe(10);
  });

  // FIX (P2): the num-side zero cases (num = 0 / null / undefined / NaN /
  // Infinity) were removed from this table — a missing numerator is now a REAL 0
  // (the roster zero), asserted by the mixed-batch test below. Only the
  // genuinely-unknowable denominators and the negative-numerator junk delta are
  // still omitted here.
  it.each([
    ['den = 0', row(600, 0)],
    ['den < 0', row(600, -5)],
    ['num < 0', row(-3, 60)],
    ['den null', row(600, null)],
    ['den undefined', row(600, undefined)],
    ['den NaN', row(600, NaN)],
    ['den Infinity', row(600, Infinity)],
  ])('omits the point when %s (rate unknowable or junk delta)', (_label, r) => {
    expect(derivedPoints([r], 'model_id')).toEqual([]);
  });

  // FIX (P2): this pinned the old zero-drop. A zero or missing numerator is now a
  // REAL 0 (the roster zero: alive, no traffic); only an unknowable denominator
  // (den = 0) is still skipped.
  it('emits a real 0 for a zero/missing numerator across a mixed batch', () => {
    const rows = [
      row(600, 60), row(0, 60), row(600, 0), row(300, 60),
      row(null, 60), row(undefined, 60), row(NaN, 60), row(Infinity, 60),
    ];
    const pts = derivedPoints(rows, 'model_id');
    expect(pts.map((p) => p.value)).toEqual([10, 0, 5, 0, 0, 0, 0]);
    expect(pts.every((p) => p.unit === 'token/s')).toBe(true);
  });

  it('emits a real 0 for a zero numerator even when the denominator is missing (idle bucket)', () => {
    // An idle bucket has no latency deltas at all, so a `series` denominator is
    // NULL — but 0 tokens is still a known 0 rate, not a gap.
    expect(derivedPoints([row(0, null), row('0', undefined)], 'model_id').map((p) => p.value)).toEqual([0, 0]);
    // A non-zero numerator with no denominator stays unknowable.
    expect(derivedPoints([row(120, null)], 'model_id')).toEqual([]);
  });

  it('decode_tps: 1200 output tokens over 30 decode-seconds -> 40 token/s', () => {
    expect(derivedPoints([row(1200, 30)], 'model_id')[0].value).toBe(40);
  });

  it('sets unit token/s and ISO t, preserving order', () => {
    const rows = [
      { bucket: new Date('2026-09-29T10:00:00.000Z'), group: 'a', num: 600, den: 60 },
      { bucket: new Date('2026-09-29T10:01:00.000Z'), group: 'b', num: 300, den: 60 },
    ];
    const pts = derivedPoints(rows, 'model_id');
    expect(pts.map((p) => p.t)).toEqual(['2026-09-29T10:00:00.000Z', '2026-09-29T10:01:00.000Z']);
    expect(pts.map((p) => p.group)).toEqual(['a', 'b']);
    expect(pts.every((p) => p.unit === 'token/s')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/series — derived metric integration (fake QueryFn, real http)
// ---------------------------------------------------------------------------

describe('GET /api/series — derived metrics (integration)', () => {
  it('decode_tps/1h/model_id -> 200 with value+unit and the derived value SQL', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model_id: 'mid-1', num: '600', den: '60' }],
      [{ model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'healthy' }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].value).toBe(10);
      expect(body[0].unit).toBe('token/s');
      expect(body[0].group).toBe('mid-1');
      const [sql, params] = firstCall(q);
      expect(sql).toContain('output_tokens');
      expect(sql).not.toContain('decode_tps_1m');
      expect(params).toEqual([3600]);
    } finally {
      await srv.close();
    }
  });

  it('input_tps/1h/model_id -> 200 (TTFT division)', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery([{ bucket, model_id: 'mid-1', num: '1200', den: '4' }], []);
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=input_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body[0].value).toBe(300);
      expect(body[0].unit).toBe('token/s');
    } finally {
      await srv.close();
    }
  });

  it('omits idle buckets (den = 0) instead of emitting a fake 0 t/s', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery([{ bucket, model_id: 'mid-1', num: '600', den: '0' }], []);
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('returns 500 {error:"internal error"} when the derived value query fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('deployment_health')) return { rows: [] };
      if (sql.includes('AS label')) return { rows: [] };
      throw new Error('derived value query boom');
    }) as unknown as FakeQuery;
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(500);
      expect(body).toEqual({ error: 'internal error' });
    } finally {
      await srv.close();
      errSpy.mockRestore();
    }
  });

  it('accepts group=model_id for a derived metric', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery([{ bucket, model_id: 'mid-9', num: '300', den: '60' }], []);
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body[0].group).toBe('mid-9');
      expect(body[0].value).toBe(5);
    } finally {
      await srv.close();
    }
  });

  it('still accepts group=model for a derived metric', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery([{ bucket, model: 'gpt-4', num: '600', den: '60' }], []);
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model');
      expect(status).toBe(200);
      expect(body[0].group).toBe('gpt-4');
      expect(body[0].value).toBe(10);
    } finally {
      await srv.close();
    }
  });

  it('derived request issues only values + health (no bridge query) and still attaches state', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = makeDispatchingQuery(
      [{ bucket, model_id: 'mid-1', num: '600', den: '60' }],
      [{ model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'error' }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      // Five queries: the derived value query + deployment_health + activity + inventory groups
      // + the scrape-health probe. The label bridge is still skipped, but the activity query is
      // now issued for derived metrics too (the derived series group by model_id, the doc's axis).
      expect(q.mock.calls).toHaveLength(5);
      expect(q.mock.calls.some((c) => String(c[0]).includes('AS label'))).toBe(false);
      // state still attaches via the direct model_id match (no bridge needed)
      expect(body[0].state).toBe('error');
      // the bridge-failure warning is never triggered
      const warns = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warns.some((m) => m.includes('bridge query failed'))).toBe(false);
    } finally {
      await srv.close();
      warnSpy.mockRestore();
    }
  });

  it('stamps litellm_model_name on model_id-grouped points from deployment_health', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model_id: 'orchestration-qwen38', num: '600', den: '60' }],
      [{ model_id: 'orchestration-qwen38', litellm_model_name: 'halogen-qwen3.8-flash-next', status: 'healthy' }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].group).toBe('orchestration-qwen38');
      expect(body[0].litellm_model_name).toBe('halogen-qwen3.8-flash-next');
    } finally {
      await srv.close();
    }
  });

  it('leaves litellm_model_name absent when a model_id point has no matching health row', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model_id: 'mid-unknown', num: '600', den: '60' }],
      [{ model_id: 'mid-other', litellm_model_name: 'other-name', status: 'healthy' }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect('litellm_model_name' in body[0]).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('does NOT stamp litellm_model_name when group != model_id (byte-identical response)', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model: 'gpt-4', num: '600', den: '60' }],
      [{ model_id: 'gpt-4', litellm_model_name: 'gpt-4-prod', status: 'healthy' }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect('litellm_model_name' in body[0]).toBe(false);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/series — requests grouped by model_id (FIX 3: raw hypertable path)
// The requests_<tier> continuous aggregate has NO model_id column, so grouping
// requests by model_id must read the RAW `requests` hypertable (bucketed by the
// tier interval) instead of the cagg — otherwise the value query 500s.
// ---------------------------------------------------------------------------

describe('GET /api/series — requests grouped by model_id (raw hypertable path)', () => {
  it('requests/1h/model_id -> 200 via the RAW hypertable (no requests_1m cagg)', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [
        { bucket, model_id: 'mid-1', value: '5' },
        { bucket, model_id: 'mid-2', value: '7' },
      ],
      [{ model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'healthy' }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body.map((p: any) => p.group).sort()).toEqual(['mid-1', 'mid-2']);
      expect(body.find((p: any) => p.group === 'mid-1').value).toBe(5);
      const [sql, params] = firstCall(q);
      expect(sql).toContain('FROM requests');
      expect(sql).toContain('time_bucket(');
      expect(sql).toContain('GROUP BY bucket, model_id');
      expect(sql).not.toContain('requests_1m');
      expect(params).toEqual([3600]);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// buildActivitySql — activity state machine SQL
// ---------------------------------------------------------------------------

describe('buildActivitySql — activity state machine SQL', () => {
  // The three scraper-SSOT counter metric literals (spelled once here, reused
  // by the literal-emission and the source-guard tests below).
  const METRIC_LITERALS = [
    'litellm_output_tokens_metric_total',
    'litellm_request_total_latency_metric_count',
    'litellm_llm_api_time_to_first_token_metric_count',
  ];

  it('emits the three scraper-SSOT counter metric literals', () => {
    const sql = buildActivitySql('1m', 'model');
    for (const lit of METRIC_LITERALS) {
      expect(sql).toContain(lit);
    }
  });

  it('reads the raw output_tokens and latency hypertables', () => {
    const sql = buildActivitySql('1m', 'model');
    expect(sql).toContain('FROM output_tokens');
    expect(sql).toContain('FROM latency');
    // activity reads RAW hypertables, never a continuous aggregate (no cagg
    // exists for these families)
    expect(sql).not.toContain('_1m');
    expect(sql).not.toContain('_5m');
  });

  it('joins the three increase CTEs with FULL OUTER JOIN and no inner join', () => {
    const sql = buildActivitySql('1m', 'model');
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    // exactly two joins: out_inc <-> req_inc and req_inc <-> ttft_inc (n <-> r and r <-> t)
    expect(count(sql, 'FULL OUTER JOIN')).toBe(2);
    // no inner/cross joins anywhere: every JOIN token is a FULL OUTER JOIN
    expect(count(sql, 'JOIN')).toBe(2);
  });

  it('projects the three increases and coalesces the join keys', () => {
    const sql = buildActivitySql('1m', 'model');
    expect(sql).toContain('out_inc');
    expect(sql).toContain('req_inc');
    expect(sql).toContain('ttft_inc');
    expect(sql).toContain('COALESCE');
  });

  it('binds $1 to the range seconds like every other query', () => {
    expect(buildActivitySql('1m', 'model')).toContain("ts >= now() - ($1 * interval '1 second')");
    expect(buildActivitySql('1m', 'model')).toContain("INTERVAL '1 minute'");
    expect(buildActivitySql('5m', 'model')).toContain("INTERVAL '5 minutes'");
    expect(buildActivitySql('1h', 'model')).toContain("INTERVAL '1 hour'");
  });

  it('throws on an unknown tier or an unknown group', () => {
    expect(() => buildActivitySql('7d', 'model')).toThrow();
    expect(() => buildActivitySql('1m', 'bogus')).toThrow();
    expect(() => buildActivitySql('1m', 'team')).toThrow();
  });

  it('aliases the group column as a single AS grp regardless of the group-by key (FIX A)', () => {
    // deriveActivityStates reads row.grp uniformly, so the SQL must emit one
    // canonical "grp" alias no matter which GROUPS member was requested.
    for (const g of GROUPS) {
      const sql = buildActivitySql('1m', g);
      expect(sql).toContain(' AS grp');
    }
    // No group-specific alias leaks into the projection.
    expect(buildActivitySql('1m', 'model')).not.toContain(' AS model');
    expect(buildActivitySql('1m', 'model_id')).not.toContain(' AS model_id');
    expect(buildActivitySql('1m', 'api_provider')).not.toContain(' AS api_provider');
  });

  it('never filters zero-delta buckets: no HAVING, no delta > 0 (FIX B)', () => {
    // Idle buckets (all increments = 0) MUST survive the query so the state
    // machine can label them "idle". A HAVING or a WHERE delta > 0 would
    // silently drop them, making idle indistinguishable from "scrape failed".
    for (const g of GROUPS) {
      const sql = buildActivitySql('1m', g);
      expect(sql).not.toContain('HAVING');
      expect(sql).not.toContain('delta > 0');
    }
  });

  it('computes increases via plain SUM per bucket, not LAG/prev_value window (FIX C)', () => {
    // The scraper (delta.go) already emits per-scrape deltas; the API must SUM
    // them per time_bucket. Re-differencing with LAG(value)/prev_value would
    // double-difference and break the counter-reset semantics.
    for (const g of GROUPS) {
      const sql = buildActivitySql('1m', g);
      expect(sql).not.toContain('LAG(');
      expect(sql).not.toContain('prev_value');
    }
  });
});

describe('server.ts source guard — activity metric literals match the scraper SSOT', () => {
  const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

  it('contains the output-tokens counter metric literal', () => {
    expect(src).toContain('litellm_output_tokens_metric_total');
  });

  it('contains the request-total-latency count metric literal', () => {
    expect(src).toContain('litellm_request_total_latency_metric_count');
  });

  it('contains the ttft count metric literal', () => {
    expect(src).toContain('litellm_llm_api_time_to_first_token_metric_count');
  });

  it("contains 'ACTIVITY_SOURCES' (positive control: the activity table set exists)", () => {
    expect(src).toContain('ACTIVITY_SOURCES');
  });
});

// ---------------------------------------------------------------------------
// deriveActivityStates — the documented 4-state rule
// ---------------------------------------------------------------------------

describe('deriveActivityStates — the documented 4-state rule', () => {
  const B = (iso: string) => new Date(iso);
  // loosely-typed rows (the file already uses any[] in its helpers)
  const row = (bucket: unknown, grp: unknown, out_inc: unknown, req_inc: unknown, ttft_inc: unknown) =>
    ({ bucket, grp, out_inc, req_inc, ttft_inc } as unknown as ActivityRow[]);

  it('walks the documented transition idle -> prefill -> healthy -> idle across consecutive buckets', () => {
    const rows = [
      row(B('2026-09-29T10:00:00.000Z'), 'gpt-4', 0, 0, 0),
      row(B('2026-09-29T10:01:00.000Z'), 'gpt-4', 0, 1, 0),
      row(B('2026-09-29T10:02:00.000Z'), 'gpt-4', 50, 1, 1),
      row(B('2026-09-29T10:03:00.000Z'), 'gpt-4', 0, 0, 0),
    ];
    const map = deriveActivityStates(rows as any[]);
    expect(map.get('2026-09-29T10:00:00.000Z|gpt-4')).toBe('idle');
    expect(map.get('2026-09-29T10:01:00.000Z|gpt-4')).toBe('prefill');
    expect(map.get('2026-09-29T10:02:00.000Z|gpt-4')).toBe('healthy');
    expect(map.get('2026-09-29T10:03:00.000Z|gpt-4')).toBe('idle');
  });

  it('output-token growth wins even when request and first-token counters also grew', () => {
    const map = deriveActivityStates([row(B('2026-09-29T10:00:00.000Z'), 'gpt-4', 12, 3, 3)] as any[]);
    expect(map.get('2026-09-29T10:00:00.000Z|gpt-4')).toBe('healthy');
  });

  it('request growth with no output growth is prefill (approximate)', () => {
    const map = deriveActivityStates([row(B('2026-09-29T10:00:00.000Z'), 'gpt-4', 0, 2, 0)] as any[]);
    expect(map.get('2026-09-29T10:00:00.000Z|gpt-4')).toBe('prefill');
  });

  it('first-token growth with no output growth is prefill', () => {
    const map = deriveActivityStates([row(B('2026-09-29T10:00:00.000Z'), 'gpt-4', 0, 0, 2)] as any[]);
    expect(map.get('2026-09-29T10:00:00.000Z|gpt-4')).toBe('prefill');
  });

  it('all three increases zero is idle (healthy but quiet)', () => {
    const map = deriveActivityStates([row(B('2026-09-29T10:00:00.000Z'), 'gpt-4', 0, 0, 0)] as any[]);
    expect(map.get('2026-09-29T10:00:00.000Z|gpt-4')).toBe('idle');
  });

  it('treats null, undefined, NaN and negative measures as zero and never invents activity', () => {
    const base = B('2026-09-29T10:00:00.000Z');
    const key = '2026-09-29T10:00:00.000Z|gpt-4';
    for (const v of [null, undefined, NaN]) {
      const map = deriveActivityStates([row(base, 'gpt-4', v, 0, 0)] as any[]);
      expect(map.get(key)).toBe('idle');
    }
    // a negative string never fabricates activity (a gap must stay idle)
    const neg = deriveActivityStates([row(base, 'gpt-4', '-5', 0, 0)] as any[]);
    expect(neg.get(key)).toBe('idle');
    // pg returns numerics as strings; a numeric string still drives the state
    const asStr = deriveActivityStates([row(base, 'gpt-4', '30', 0, 0)] as any[]);
    expect(asStr.get(key)).toBe('healthy');
  });

  it('keys points by ISO bucket + group so they match SeriesPoint.t exactly', () => {
    const map = deriveActivityStates([row(B('2026-09-29T10:00:00.000Z'), 'mid-1', 50, 1, 1)] as any[]);
    expect(map.size).toBe(1);
    expect([...map.keys()][0]).toBe('2026-09-29T10:00:00.000Z|mid-1');
  });

  it('collapses duplicate keys worst-wins using STATE_RANK (idle < healthy < prefill < error)', () => {
    const base = B('2026-09-29T10:00:00.000Z');
    const key = '2026-09-29T10:00:00.000Z|gpt-4';
    const bothIdleHealthy = deriveActivityStates([
      row(base, 'gpt-4', 0, 0, 0),
      row(base, 'gpt-4', 50, 0, 0),
    ] as any[]);
    expect(bothIdleHealthy.get(key)).toBe('healthy');
    const bothHealthyPrefill = deriveActivityStates([
      row(base, 'gpt-4', 50, 0, 0),
      row(base, 'gpt-4', 0, 2, 0),
    ] as any[]);
    expect(bothHealthyPrefill.get(key)).toBe('prefill');
  });

  it('skips rows with no bucket or no group instead of inventing a point', () => {
    const rows = [
      { bucket: null, grp: 'g', out_inc: 5, req_inc: 0, ttft_inc: 0 },
      { bucket: new Date(), grp: null, out_inc: 5, req_inc: 0, ttft_inc: 0 },
    ] as any[];
    const map = deriveActivityStates(rows);
    expect(map.size).toBe(0);
  });

  it('reads the grp property (not group) so SQL-aliased rows are processed (FIX A)', () => {
    // buildActivitySql emits "AS grp", so the pg result carries a `grp` key,
    // never `group`. A row that has ONLY grp must be keyed and classified.
    const base = B('2026-09-29T10:00:00.000Z');
    const rows = [{ bucket: base, grp: 'gpt-4', out_inc: 50, req_inc: 0, ttft_inc: 0 }] as any[];
    const map = deriveActivityStates(rows);
    expect(map.size).toBe(1);
    expect(map.get('2026-09-29T10:00:00.000Z|gpt-4')).toBe('healthy');
  });

  it('skips a row whose grp is null even if a legacy group field is set (FIX A)', () => {
    // Guards against accidentally reading the wrong property: if the code
    // checks `row.group` instead of `row.grp`, this row would slip through.
    const base = B('2026-09-29T10:00:00.000Z');
    const rows = [{ bucket: base, group: 'gpt-4', grp: null, out_inc: 50, req_inc: 0, ttft_inc: 0 }] as any[];
    const map = deriveActivityStates(rows);
    expect(map.size).toBe(0);
  });

  it('all-zero increments on a grp-keyed row yield idle (FIX B)', () => {
    // The scraper emits a ~5-min heartbeat, so a
    // genuinely idle deployment still produces rows with all-zero deltas.
    // Those rows must map to "idle", not be skipped or misclassified.
    const base = B('2026-09-29T10:00:00.000Z');
    const rows = [{ bucket: base, grp: 'quiet-model', out_inc: 0, req_inc: 0, ttft_inc: 0 }] as any[];
    const map = deriveActivityStates(rows);
    expect(map.get('2026-09-29T10:00:00.000Z|quiet-model')).toBe('idle');
  });

  it('derives independent per-group states in the same bucket: busy → healthy, quiet → idle (FIX B)', () => {
    // Two different deployments sharing the same time bucket must not
    // interfere: the busy one is healthy, the quiet one is idle. This guards
    // against an implementation that keys by bucket alone (dropping the group).
    const base = B('2026-09-29T10:00:00.000Z');
    const rows = [
      { bucket: base, grp: 'busy-model', out_inc: 100, req_inc: 5, ttft_inc: 5 },
      { bucket: base, grp: 'quiet-model', out_inc: 0, req_inc: 0, ttft_inc: 0 },
    ] as any[];
    const map = deriveActivityStates(rows);
    expect(map.get('2026-09-29T10:00:00.000Z|busy-model')).toBe('healthy');
    expect(map.get('2026-09-29T10:00:00.000Z|quiet-model')).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// attachStates — activity state machine precedence (TDD RED)
//
// The activity state machine
// derives a per-bucket/per-group ActivityState ("healthy" | "prefill" | "idle")
// from the token/request/TTFT increments. `attachStates` is being extended with
// an OPTIONAL 4th argument — an activity-state map keyed by `point.t|point.group`
// — so the per-point, per-bucket activity reading takes PRECEDENCE over the
// range-wide deployment-health reading, while the existing 3-arg behavior is
// fully preserved when no activity map is supplied.
//
// TDD: the 4th parameter does not exist in server.ts yet, so the 4-arg calls go
// through `withActivity` (a typed cast). That keeps the file compiling clean
// (tsc: 0 errors) while every assertion below sits RED at runtime — the current
// 3-arg implementation ignores the activity map, so only the no-map /
// deployment-fallback tests happen to pass.
// ---------------------------------------------------------------------------

describe('attachStates — activity state machine precedence', () => {
  const T = '2026-09-29T10:00:00.000Z';

  // A single series point at the fixed ISO bucket. `value` is irrelevant to the
  // state lookup and kept at a stable 10 for readability.
  const pt = (group: string, t: string = T): SeriesPoint => ({ t, group, value: 10 });

  // Central typed cast for the not-yet-present 4th `activityStates` parameter.
  // See the block note above: this is what lets the RED tests compile today.
  const withActivity = (
    points: SeriesPoint[],
    stateByGroup: Map<string, DeploymentState>,
    labelToModelIds: Map<string, string[]>,
    activityStates: Map<string, ActivityState>,
  ): SeriesPoint[] =>
    (attachStates as unknown as (
      points: SeriesPoint[],
      stateByGroup: Map<string, DeploymentState>,
      labelToModelIds: Map<string, string[]>,
      activityStates: Map<string, ActivityState>,
    ) => SeriesPoint[])(points, stateByGroup, labelToModelIds, activityStates);

  const emptyHealth = (): Map<string, DeploymentState> => new Map();
  const emptyBridge = (): Map<string, string[]> => new Map();
  const act = (key: string, state: ActivityState): Map<string, ActivityState> =>
    new Map([[key, state]]);
  const key = (group: string, t: string = T): string => `${t}|${group}`;

  it('error from deployment_health is absolute and is never masked by a derived activity state', () => {
    // error is split out as its OWN blue
    // state, and deployment_health is the authority for error — so a derived
    // activity state (idle/prefill/healthy) can NEVER mask a deployment error.
    const health = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'error' },
    ]);
    const out = withActivity([pt('mid-1')], health, emptyBridge(), act(key('mid-1'), 'idle'));
    expect(out[0].state).toBe('error');

    // A derived "healthy" is just an availability-flavoured statement too — error still wins.
    const out2 = withActivity([pt('mid-1')], health, emptyBridge(), act(key('mid-1'), 'healthy'));
    expect(out2[0].state).toBe('error');
  });

  it('health "healthy" is availability, not activity, so a derived idle wins over it', () => {
    // Health "healthy" is an AVAILABILITY statement (deployment_state 0/1/2), not an
    // activity statement, so it must not mask a derived idle.
    const health = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'healthy' },
    ]);
    const activity = act(key('mid-1'), 'idle');

    const out = withActivity([pt('mid-1')], health, emptyBridge(), activity);

    expect(out[0].state).toBe('idle');
  });

  it('activity state is used when the deployment map has no reading for the point', () => {
    const out = withActivity([pt('mid-1')], emptyHealth(), emptyBridge(), act(key('mid-1'), 'healthy'));

    expect(out[0].state).toBe('healthy');
  });

  it('prefill traffic overrides a healthy deployment reading', () => {
    const health = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'healthy' },
    ]);
    const activity = act(key('mid-1'), 'prefill');

    const out = withActivity([pt('mid-1')], health, emptyBridge(), activity);

    expect(out[0].state).toBe('prefill');
  });

  it('falls back to the deployment state when the point has no activity reading', () => {
    const health = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'error' },
    ]);
    const activity = act('other-bucket|mid-1', 'idle');

    const out = withActivity([pt('mid-1')], health, emptyBridge(), activity);

    expect(out[0].state).toBe('error');
  });

  it('resolves each point independently — the map is keyed by bucket AND group', () => {
    // Deliberately uses a NON-error deployment state ('healthy'): the error-absolute
    // precedence is pinned by the separate
    // `error from deployment_health is absolute` test, so an 'error' reading here
    // would mask the per-bucket behaviour this test exists to verify.
    const health = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'healthy' },
    ]);
    const t2 = '2026-09-29T10:05:00.000Z';
    const activity = act(key('mid-1', T), 'idle');

    const out = withActivity([pt('mid-1', T), pt('mid-1', t2)], health, emptyBridge(), activity);

    expect(out[0].state).toBe('idle'); // bucket WITH an activity reading: the derived idle wins over the non-error 'healthy' availability reading
    expect(out[1].state).toBe('healthy'); // bucket WITHOUT a reading: falls back to the deployment state
  });

  it('leaves state undefined when neither activity nor deployment resolves (never fabricated)', () => {
    const out = withActivity([pt('nowhere')], emptyHealth(), emptyBridge(), new Map());

    expect(out[0].state).toBeUndefined();
    expect('state' in out[0]).toBe(false);
  });

  it('keeps the legacy 3-arg contract intact when no activity map is supplied', () => {
    const health = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'error' },
    ]);

    const out = attachStates([pt('mid-1')], health, emptyBridge());

    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('error');
  });

  it('an empty activity map is identical to omitting the argument (regression pin)', () => {
    const health = buildStateByGroup([
      { model_id: 'mid-1', litellm_model_name: 'dep-a', status: 'error' },
    ]);
    const points = [pt('mid-1'), pt('nowhere')];

    const viaEmpty = withActivity(points, health, emptyBridge(), new Map<string, ActivityState>());
    const plain = attachStates(points, health, emptyBridge());

    // An empty activity map must behave exactly like omitting the argument.
    expect(viaEmpty).toEqual(plain);
    // And the unresolved point carries NO 'state' key (never fabricated).
    expect('state' in plain[1]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/series — activity state machine integration (TDD RED)
//
// End-to-end wiring (the part server.ts does not implement yet): for the
// request-side cagg metrics (grouped by `model` / `api_provider`) the handler
// issues a FOURTH query — the activity-increments query (recognised by its
// `out_inc` projection, routed by `makeDispatchingQuery`'s 4th slot) — derives
// a per-point activity state from those rows, and lets it take precedence over
// the deployment-health state. The value series is always served even when the
// activity query fails (it is failure-tolerant, like the health/bridge queries).
// Derived metrics group by `model_id` directly and read raw hypertables, so no
// activity query is issued for them (4th slot stays empty).
// ---------------------------------------------------------------------------

describe('GET /api/series — activity state machine integration', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('issues a fourth activity query for a request-side metric (requests/1h/model)', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model: 'gpt-4', value: '10' }],
      [],
      [],
      [],
    );
    const srv = await startServer(q);
    try {
      const { status } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
      expect(status).toBe(200);
      // value + health + bridge + activity + inventory groups + scrape probe.
      expect(q).toHaveBeenCalledTimes(6);
    } finally {
      await srv.close();
    }
  });

  it('deployment error survives a derived idle on the real round-trip (error is absolute)', async () => {
    // deployment_health is the error
    // authority, so the derived idle (0/0/0 increments) must NOT mask the error.
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model: 'gpt-4', value: '10' }],
      [{ model_id: 'mid-1', litellm_model_name: 'gpt-4', status: 'error' }],
      [{ model: 'gpt-4', model_id: 'mid-1' }],
      [{ bucket, grp: 'gpt-4', out_inc: 0, req_inc: 0, ttft_inc: 0 }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      // error is absolute and is never masked by a derived idle.
      expect(body[0].state).toBe('error');
    } finally {
      await srv.close();
    }
  });

  it('pushes per-bucket activity states on a real round-trip when the deployment is not in error', async () => {
    const bucketA = new Date('2026-09-29T10:00:00.000Z');
    const bucketB = new Date('2026-09-29T10:05:00.000Z');
    const q = makeDispatchingQuery(
      [
        { bucket: bucketA, model: 'gpt-4', value: '10' },
        { bucket: bucketB, model: 'gpt-4', value: '0' },
      ],
      [],
      [],
      [
        { bucket: bucketA, grp: 'gpt-4', out_inc: '40', req_inc: '1', ttft_inc: '1' },
        { bucket: bucketB, grp: 'gpt-4', out_inc: '0', req_inc: '0', ttft_inc: '0' },
      ],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
      expect(status).toBe(200);
      // No deployment reading, so the derived per-bucket activity states push through.
      expect(body[0].t).toBe('2026-09-29T10:00:00.000Z');
      expect(body[0].state).toBe('healthy');
      expect(body[1].state).toBe('idle');
    } finally {
      await srv.close();
    }
  });

  it('falls back to the deployment state when the activity query returns no rows', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model: 'gpt-4', value: '10' }],
      [{ model_id: 'mid-1', litellm_model_name: 'gpt-4', status: 'error' }],
      [{ model: 'gpt-4', model_id: 'mid-1' }],
      [],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
      expect(status).toBe(200);
      expect(body[0].state).toBe('error');
    } finally {
      await srv.close();
    }
  });

  it('still serves the value series when the activity query fails', async () => {
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    // A fake query whose activity (fourth) query throws while the others
    // succeed — the same failure-tolerance convention already used for the
    // deployment_health and bridge queries in this file.
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('out_inc')) throw new Error('activity query boom');
      if (sql.includes('AS label')) return { rows: [] };
      if (sql.includes('deployment_health')) return { rows: [] };
      return { rows: [{ bucket, model: 'gpt-4', value: '10' }] };
    }) as unknown as FakeQuery;
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].value).toBe(10);
    } finally {
      await srv.close();
    }
  });

  it('derived metrics also issue the activity query and receive activity states', async () => {
    // Derived series group by model_id — which is exactly the doc's per-model_id
    // axis — so the activity query MUST run
    // for derived metrics too. The label bridge is STILL skipped (no label -> model_id
    // mapping is needed when the series is already grouped by model_id).
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model_id: 'mid-1', num: '600', den: '60' }],
      [],
      [],
      [{ bucket, grp: 'mid-1', out_inc: '30', req_inc: '1', ttft_inc: '1' }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=decode_tps&range=1h&group=model_id');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0].value).toBe(10);
      expect(body[0].unit).toBe('token/s');
      // out_inc > 0 -> derived activity state "healthy".
      expect(body[0].state).toBe('healthy');
      // value + deployment_health + activity + inventory groups + scrape-health probe;
      // the label bridge is still skipped.
      expect(q).toHaveBeenCalledTimes(5);
      expect(q.mock.calls.some((c) => String(c[0]).includes('AS label'))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('reports an all-zero bucket as idle even when deployment_health says healthy', async () => {
    // Regression: the activity state machine must override the range-wide
    // deployment_health reading. A bucket where out/req/ttft are all zero is
    // "idle" per the 4-state rule, regardless of what deployment_health says
    // about that deployment overall.
    const bucket = new Date('2026-09-29T10:00:00.000Z');
    const q = makeDispatchingQuery(
      [{ bucket, model: 'gpt-4', value: '10' }],
      [{ model_id: 'mid-1', litellm_model_name: 'gpt-4', status: 'healthy' }],
      [{ model: 'gpt-4', model_id: 'mid-1' }],
      [{ bucket, grp: 'gpt-4', out_inc: 0, req_inc: 0, ttft_inc: 0 }],
    );
    const srv = await startServer(q);
    try {
      const { status, body } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      // deployment_health says healthy, but the per-bucket activity reading
      // (all zeros) takes precedence → idle.
      expect(body[0].state).toBe('idle');
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// KPI endpoint — unit (GET /api/kpis?range= -> the six fixed fields;
// unknown/missing -> null, scraped-zero -> 0)
// ---------------------------------------------------------------------------

describe('KPI endpoint — unit', () => {
  describe('validateKpiParams — range only, same error strings as /api/series', () => {
    it('accepts every documented range', () => {
      for (const range of ['1h', '24h', '7d']) {
        expect(validateKpiParams({ range })).toEqual({ ok: true, range });
      }
    });
    it('rejects a missing or empty range', () => {
      expect(validateKpiParams({})).toEqual({ ok: false, error: 'missing or invalid range' });
      expect(validateKpiParams({ range: '' })).toEqual({ ok: false, error: 'missing or invalid range' });
    });
    it('rejects a range that is not a RANGE_SECONDS key', () => {
      expect(validateKpiParams({ range: '30d' })).toEqual({ ok: false, error: 'unknown range: 30d' });
    });
  });

  describe('buildKpiTotalSql — range total over the per-interval deltas', () => {
    it('builds the exact total SQL per family and tier', () => {
      expect(buildKpiTotalSql('requests', '1m')).toBe(
        "SELECT SUM(sum_value) AS total FROM requests_1m WHERE bucket >= now() - ($1 * interval '1 second')",
      );
      expect(buildKpiTotalSql('spend', '5m')).toBe(
        "SELECT SUM(sum_value) AS total FROM spend_5m WHERE bucket >= now() - ($1 * interval '1 second')",
      );
      expect(() => buildKpiTotalSql('tokens', '1h')).toThrow();
    });
    it('binds the window as $1 only (nothing else interpolated)', () => {
      const sql = buildKpiTotalSql('requests', '1m');
      expect(sql).toContain('($1 * interval');
      expect(sql).not.toContain('$2');
      expect(sql).not.toContain('3600');
    });
    it('throws on a non-whitelisted family before interpolating', () => {
      expect(() => buildKpiTotalSql('errors', '1m')).toThrow();
      expect(() => buildKpiTotalSql('latency', '1m')).toThrow();
      expect(() => buildKpiTotalSql('requests_1m; DROP TABLE requests', '1m')).toThrow();
    });
    it('throws on an unknown tier', () => {
      expect(() => buildKpiTotalSql('requests', '30m')).toThrow();
      expect(() => buildKpiTotalSql('requests', '')).toThrow();
    });
  });

  describe('buildKpiTotalRawSql — raw-tier KPI total (tokens family)', () => {
    it('builds the exact raw-tier total SQL for the tokens KPI', () => {
      expect(buildKpiTotalRawSql('total_tokens')).toBe(
        "SELECT SUM(value) AS total FROM total_tokens WHERE ts >= now() - ($1 * interval '1 second')",
      );
    });
    it('binds the raw-tier window as $1 only (nothing else interpolated)', () => {
      const sql = buildKpiTotalRawSql('total_tokens');
      expect(sql).toContain('($1 * interval');
      expect(sql).not.toContain('$2');
      expect(sql).not.toContain('3600');
    });
  });

  describe('kpiTotal — one total row -> number | null (never a fake 0)', () => {
    it('coerces the pg text total; a scraped zero stays 0', () => {
      expect(kpiTotal([{ total: '12.5' }])).toBe(12.5);
      expect(kpiTotal([{ total: 0 }])).toBe(0);
    });
    it('returns null for no row, a null total, or a non-finite total', () => {
      expect(kpiTotal([])).toBeNull();
      expect(kpiTotal([{ total: null }])).toBeNull();
      expect(kpiTotal([{ total: undefined }])).toBeNull();
      expect(kpiTotal([{ total: 'nope' }])).toBeNull();
    });
  });

  describe('countHealthyDeployments — distinct healthy model_ids', () => {
    const row = (model_id: string | null, status: string | null): HealthRow => ({
      model_id,
      litellm_model_name: null,
      status,
    });

    it('counts distinct healthy model_ids', () => {
      expect(countHealthyDeployments([row('m1', 'healthy'), row('m2', 'healthy'), row('m3', 'error')])).toBe(2);
    });
    it('worst state wins per model_id — error beats healthy', () => {
      expect(countHealthyDeployments([row('m1', 'healthy'), row('m1', 'error'), row('m2', 'healthy')])).toBe(1);
    });
    it('worst state wins per model_id — prefill beats healthy', () => {
      expect(countHealthyDeployments([row('m1', 'healthy'), row('m1', 'prefill')])).toBe(0);
    });
    it('treats an unknown status as error (parity with buildStateByGroup)', () => {
      expect(countHealthyDeployments([row('m1', 'weird')])).toBe(0);
    });
    it('skips rows with a null/undefined model_id', () => {
      const noKey = { litellm_model_name: 'x', status: 'healthy' } as unknown as HealthRow;
      expect(countHealthyDeployments([row(null, 'healthy'), noKey])).toBeNull();
    });
    it('ignores a null-status row but still counts the healthy ones', () => {
      expect(countHealthyDeployments([row('m1', null), row('m2', 'healthy')])).toBe(1);
    });
    it('empty input -> null (unknown, never a fake 0)', () => {
      expect(countHealthyDeployments([])).toBeNull();
    });
    it('all-error input -> 0', () => {
      expect(countHealthyDeployments([row('m1', 'error'), row('m2', 'error')])).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Breakdown endpoint — unit (GET /api/breakdown?metric=spend&range=24h
// -> [{ label, value }]; apps/web/src/lib/types.ts Breakdown is {label,value})
// ---------------------------------------------------------------------------

describe('Breakdown endpoint — unit', () => {
  describe('validateBreakdownParams — cagg-backed metrics only, group defaults to model', () => {
    it('accepts a cagg-backed metric and defaults group to "model"', () => {
      expect(validateBreakdownParams({ metric: 'spend', range: '24h' })).toEqual({
        ok: true,
        metric: 'spend',
        range: '24h',
        group: 'model',
      });
    });
    it('accepts every metric of the frontend Metric union', () => {
      for (const metric of ['requests', 'errors', 'spend', 'tokens', 'latency']) {
        expect(validateBreakdownParams({ metric, range: '1h' }).ok).toBe(true);
      }
    });
    it('honours an explicit whitelisted group', () => {
      expect(validateBreakdownParams({ metric: 'tokens', range: '7d', group: 'model_id' })).toEqual({
        ok: true,
        metric: 'tokens',
        range: '7d',
        group: 'model_id',
      });
    });
    it('rejects the derived metrics — they are not cagg-backed', () => {
      for (const metric of ['decode_tps', 'input_tps', 'decode_tps_implied']) {
        expect(validateBreakdownParams({ metric, range: '1h' })).toEqual({ ok: false, error: `unknown metric: ${metric}` });
      }
    });
    it('rejects an unknown or missing metric', () => {
      expect(validateBreakdownParams({ metric: 'bogus', range: '1h' })).toEqual({ ok: false, error: 'unknown metric: bogus' });
      expect(validateBreakdownParams({ range: '1h' })).toEqual({ ok: false, error: 'missing or invalid metric' });
    });
    it('rejects a missing or unknown range', () => {
      expect(validateBreakdownParams({ metric: 'spend' })).toEqual({ ok: false, error: 'missing or invalid range' });
      expect(validateBreakdownParams({ metric: 'spend', range: '30d' })).toEqual({ ok: false, error: 'unknown range: 30d' });
    });
    it('rejects a group outside GROUPS', () => {
      expect(validateBreakdownParams({ metric: 'spend', range: '1h', group: 'api_key' })).toEqual({
        ok: false,
        error: 'unknown group: api_key',
      });
    });
  });

  describe('buildBreakdownSql — aggregate per group, ordered by value', () => {
    it('SUMs sum_value for the counter families', () => {
      expect(buildBreakdownSql('spend', '5m', 'model')).toBe(
        "SELECT model AS label, SUM(sum_value) AS value FROM spend_5m WHERE bucket >= now() - ($1 * interval '1 second') GROUP BY model ORDER BY value DESC",
      );
      expect(buildBreakdownSql('requests', '1m', 'model')).toContain('SUM(sum_value) AS value FROM requests_1m');
    });
    it('AVGs avg_value for the latency gauge', () => {
      expect(buildBreakdownSql('latency', '5m', 'model')).toContain('AVG(avg_value) AS value FROM latency_5m');
    });
    it('builds the tokens breakdown from the RAW total_tokens hypertable (no tokens cagg exists)', () => {
      expect(buildBreakdownSql('tokens', '1h', 'model')).toBe(
        "SELECT model AS label, SUM(value) AS value FROM total_tokens WHERE ts >= now() - ($1 * interval '1 second') GROUP BY model ORDER BY value DESC",
      );
      const sql = buildBreakdownSql('tokens', '1h', 'model');
      expect(sql).toContain('FROM total_tokens');
      expect(sql).toContain('SUM(value) AS value');
      expect(sql).toContain("ts >= now() - ($1 * interval '1 second')");
      expect(sql).toContain('GROUP BY model');
      expect(sql).toContain('ORDER BY value DESC');
      expect(sql).not.toContain('tokens_1h');
      expect(sql).not.toContain('sum_value');
      expect(sql).not.toContain('bucket');
    });
    it('groups the raw tokens breakdown by every whitelisted group', () => {
      const provider = buildBreakdownSql('tokens', '5m', 'api_provider');
      expect(provider).toContain('SELECT api_provider AS label');
      expect(provider).toContain('GROUP BY api_provider');
      expect(provider).toContain('FROM total_tokens');
      const modelId = buildBreakdownSql('tokens', '1m', 'model_id');
      expect(modelId).toContain('SELECT model_id AS label');
      expect(modelId).toContain('GROUP BY model_id');
      expect(modelId).toContain('FROM total_tokens');
      for (const sql of [provider, modelId]) {
        expect(sql).not.toMatch(/tokens_(1m|5m|1h)/);
        expect(sql).not.toContain('sum_value');
        expect(sql).not.toContain('bucket');
      }
    });
    it('still throws for an invalid group on the raw tokens path', () => {
      expect(() => buildBreakdownSql('tokens', '1h', 'api_key')).toThrow();
    });
    it('groups by the whitelisted group column', () => {
      const sql = buildBreakdownSql('spend', '1m', 'model_id');
      expect(sql).toContain('SELECT model_id AS label');
      expect(sql).toContain('GROUP BY model_id');
    });
    it('throws on an unknown group or tier before interpolating', () => {
      expect(() => buildBreakdownSql('spend', '5m', 'api_key')).toThrow();
      expect(() => buildBreakdownSql('spend', '30m', 'model')).toThrow();
    });
    it('throws for a metric with no value column (errors has no DB backing)', () => {
      expect(() => buildBreakdownSql('errors', '5m', 'model')).toThrow();
    });
  });

  describe('toBreakdown — rows -> [{label,value}]', () => {
    it('coerces pg text values to numbers', () => {
      expect(toBreakdown([{ label: 'gpt-4', value: '10.5' }])).toEqual([{ label: 'gpt-4', value: 10.5 }]);
    });
    it('maps a NULL aggregate to 0 and a non-finite value to 0', () => {
      expect(toBreakdown([{ label: 'a', value: null }])).toEqual([{ label: 'a', value: 0 }]);
      expect(toBreakdown([{ label: 'a', value: 'nope' }])).toEqual([{ label: 'a', value: 0 }]);
    });
    it('labels a null/undefined group "(unknown)" (same as the series handler)', () => {
      expect(toBreakdown([{ label: null, value: '1' }])[0].label).toBe('(unknown)');
      expect(toBreakdown([{}])[0].label).toBe('(unknown)');
    });
    it('sorts by value descending, label ascending on ties', () => {
      expect(toBreakdown([{ label: 'b', value: '1' }, { label: 'a', value: '5' }, { label: 'c', value: '5' }])).toEqual([
        { label: 'a', value: 5 },
        { label: 'c', value: 5 },
        { label: 'b', value: 1 },
      ]);
    });
    it('maps every row — the contract has no row limit', () => {
      const rows = Array.from({ length: 60 }, (_, i) => ({ label: `m${i}`, value: String(i) }));
      expect(toBreakdown(rows)).toHaveLength(60);
    });
  });
});

// ---------------------------------------------------------------------------
// KPI + breakdown endpoints — helpers (same style as makeFakeQuery/getSeries)
// ---------------------------------------------------------------------------

/** GET `${base}/api/kpis?${qs}` and return status + parsed JSON body. */
async function getKpis(base: string, qs: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/kpis?${qs}`);
  const body = await res.json();
  return { status: res.status, body };
}

/** GET `${base}/api/breakdown?${qs}` and return status + parsed JSON body. */
async function getBreakdown(base: string, qs: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/breakdown?${qs}`);
  const body = await res.json();
  return { status: res.status, body };
}

/**
 * A `vi.fn()` fake `QueryFn` for /api/kpis, which issues FOUR sub-queries at
 * once (three range totals — requests, spend, and the raw `total_tokens` total —
 * plus the deployment-health query). It dispatches on the SQL text so each
 * sub-query can be canned independently, and `fail` names one sub-query that
 * rejects instead — used to pin the per-query failure tolerance.
 */
function makeKpiQuery(spec: {
  requests?: any[];
  spend?: any[];
  tokens?: any[];
  health?: any[];
  fail?: 'requests' | 'spend' | 'tokens' | 'health';
}): FakeQuery {
  return vi.fn(async (sql: string, _params: unknown[]) => {
    const which: 'requests' | 'spend' | 'tokens' | 'health' | 'unknown' = sql.includes('deployment_health')
      ? 'health'
      : sql.includes('FROM requests_')
        ? 'requests'
        : sql.includes('FROM spend_')
          ? 'spend'
          : sql.includes('FROM total_tokens')
            ? 'tokens'
            : 'unknown';
    if (spec.fail === which) throw new Error(`injected failure: ${which}`);
    return { rows: (spec[which as 'requests' | 'spend' | 'tokens' | 'health'] ?? []) as any[] };
  }) as unknown as FakeQuery;
}

// ---------------------------------------------------------------------------
// GET /api/kpis — integration (the six fixed fields;
// unknown -> null, never a fabricated 0)
// ---------------------------------------------------------------------------

describe('GET /api/kpis — integration', () => {
  it('serves all six keys, derives rps from the requests total, and nulls the two KPIs with no data source', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const srv = await startServer(
      makeKpiQuery({
        requests: [{ total: '7200' }],
        spend: [{ total: '12.5' }],
        tokens: [{ total: '900' }],
        health: [
          { model_id: 'm1', litellm_model_name: null, status: 'healthy' },
          { model_id: 'm2', litellm_model_name: null, status: 'healthy' },
          { model_id: 'm3', litellm_model_name: null, status: 'error' },
        ],
      }),
    );
    try {
      const { status, body } = await getKpis(srv.base, 'range=1h');

      expect(status).toBe(200);
      expect(Object.keys(body).sort()).toEqual([
        'error_rate',
        'healthy_deployments',
        'p95_ms',
        'rps',
        'spend_usd',
        'tokens',
      ]);
      expect(body.rps).toBe(2); // 7200 requests / 3600s
      expect(body.spend_usd).toBe(12.5);
      expect(body.tokens).toBe(900);
      expect(body.healthy_deployments).toBe(2);
      // No data source for either of these — null, never a fabricated number.
      expect(body.error_rate).toBeNull();
      expect(body.p95_ms).toBeNull();

      // Four sub-queries, each binding the window as $1 = range seconds.
      expect(srv).toBeTruthy();
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('error_rate has no DB backing'))).toBe(true);
      expect(messages.some((m) => m.includes('p95_ms has no DB backing'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await srv.close();
    }
  });

  it('issues exactly four queries, each bound to [3600], reusing the health query', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = makeKpiQuery({ requests: [{ total: '10' }] });
    const srv = await startServer(q);
    try {
      const { status } = await getKpis(srv.base, 'range=1h');
      expect(status).toBe(200);
      expect(q).toHaveBeenCalledTimes(4);
      for (const call of q.mock.calls) {
        expect(call[1]).toEqual([3600]);
      }
      const sqls = q.mock.calls.map((c) => String(c[0]));
      expect(sqls.filter((s) => s.includes('FROM requests_1m'))).toHaveLength(1);
      expect(sqls.filter((s) => s.includes('FROM spend_1m'))).toHaveLength(1);
      expect(sqls.filter((s) => s.includes('FROM total_tokens'))).toHaveLength(1);
      expect(sqls.filter((s) => s.includes('deployment_health'))).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      await srv.close();
    }
  });

  it('tolerates a failing sub-query: 200 with only that field null', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = makeKpiQuery({
      requests: [{ total: '7200' }],
      spend: [{ total: '12.5' }],
      tokens: [{ total: '900' }],
      health: [{ model_id: 'm1', litellm_model_name: null, status: 'healthy' }],
      fail: 'spend',
    });
    const srv = await startServer(q);
    try {
      const { status, body } = await getKpis(srv.base, 'range=1h');
      expect(status).toBe(200);
      expect(body.spend_usd).toBeNull();
      expect(typeof body.rps).toBe('number');
      expect(typeof body.tokens).toBe('number');
      expect(typeof body.healthy_deployments).toBe('number');
      expect(q).toHaveBeenCalledTimes(4);
    } finally {
      warnSpy.mockRestore();
      await srv.close();
    }
  });

  it('tolerates a failing health query: healthy_deployments is null, not a fake 0', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = makeKpiQuery({ requests: [{ total: '1' }], fail: 'health' });
    const srv = await startServer(q);
    try {
      const { status, body } = await getKpis(srv.base, 'range=1h');
      expect(status).toBe(200);
      expect(body.healthy_deployments).toBeNull();
      expect(typeof body.rps).toBe('number');
    } finally {
      warnSpy.mockRestore();
      await srv.close();
    }
  });

  it('emits null (not 0) when a total query returns no row', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = makeKpiQuery({ requests: [], spend: [{ total: '3' }], tokens: [{ total: '4' }] });
    const srv = await startServer(q);
    try {
      const { status, body } = await getKpis(srv.base, 'range=1h');
      expect(status).toBe(200);
      expect(body.rps).toBeNull();
      expect(body.spend_usd).toBe(3);
    } finally {
      warnSpy.mockRestore();
      await srv.close();
    }
  });

  it('returns 400 without querying for a missing or unknown range', async () => {
    const q = makeKpiQuery({});
    const srv = await startServer(q);
    try {
      const missing = await getKpis(srv.base, '');
      expect(missing.status).toBe(400);
      expect(typeof missing.body.error).toBe('string');
      const unknown = await getKpis(srv.base, 'range=30d');
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toBe('unknown range: 30d');
      expect(q).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('binds the tokens raw total query to the requested range seconds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [range, seconds] of [['1h', 3600], ['24h', 86400], ['7d', 604800]] as const) {
      const q = makeKpiQuery({ tokens: [{ total: '900' }] });
      const srv = await startServer(q);
      try {
        const { status, body } = await getKpis(srv.base, `range=${range}`);
        expect(status).toBe(200);
        const calls = q.mock.calls.filter((c) => String(c[0]).includes('FROM total_tokens'));
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toEqual([seconds]);
        expect(body.tokens).toBe(900);
      } finally {
        await srv.close();
      }
    }
    warnSpy.mockRestore();
  });

  it('never emits SQL against the dropped merged tokens tables', async () => {
    const q = makeKpiQuery({ requests: [{ total: '1' }], spend: [{ total: '1' }], tokens: [{ total: '1' }] });
    const srv = await startServer(q);
    try {
      for (const range of ['1h', '24h', '7d']) { await getKpis(srv.base, `range=${range}`); }
      const sqls = q.mock.calls.map((c) => String(c[0]));
      expect(sqls.length).toBe(12);
      for (const sql of sqls) {
        expect(sql).not.toMatch(/tokens_1m|tokens_5m|tokens_1h/);
        expect(sql).not.toMatch(/\bFROM tokens\b/);
      }
      expect(sqls.some((s) => s.includes('FROM total_tokens'))).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/breakdown — integration
// ---------------------------------------------------------------------------

describe('GET /api/breakdown — integration', () => {
  it('serves [{label,value}] from the cagg rows and binds the window', async () => {
    const q = vi.fn(async () => ({
      rows: [
        { label: 'gpt-4', value: '9.5' },
        { label: 'llama', value: '1' },
      ],
    })) as unknown as FakeQuery;
    const srv = await startServer(q);
    try {
      const { status, body } = await getBreakdown(srv.base, 'metric=spend&range=24h');
      expect(status).toBe(200);
      expect(body).toEqual([
        { label: 'gpt-4', value: 9.5 },
        { label: 'llama', value: 1 },
      ]);
      expect(q).toHaveBeenCalledTimes(1);
      const [sql, params] = firstCall(q);
      expect(sql).toContain('spend_5m');
      expect(sql).toContain('SUM(sum_value)');
      expect(sql).toContain('GROUP BY model');
      expect(params).toEqual([86400]);
    } finally {
      await srv.close();
    }
  });

  it('serves the tokens breakdown from the RAW total_tokens hypertable and binds the window', async () => {
    const q = vi.fn(async () => ({
      rows: [
        { label: 'gpt-4', value: '1500' },
        { label: 'llama', value: '250' },
      ],
    })) as unknown as FakeQuery;
    const srv = await startServer(q);
    try {
      const { status, body } = await getBreakdown(srv.base, 'metric=tokens&range=24h');
      expect(status).toBe(200);
      expect(body).toEqual([
        { label: 'gpt-4', value: 1500 },
        { label: 'llama', value: 250 },
      ]);
      expect(q).toHaveBeenCalledTimes(1);
      const [sql, params] = firstCall(q);
      expect(sql).toContain('FROM total_tokens');
      expect(sql).toContain('SUM(value)');
      expect(sql).toContain('ts >=');
      expect(params).toEqual([86400]);
      expect(sql).not.toMatch(/tokens_(1m|5m|1h)/);
    } finally {
      await srv.close();
    }
  });

  it('aggregates the latency gauge with AVG(avg_value)', async () => {
    const q = vi.fn(async () => ({ rows: [{ label: 'openai', value: '120' }] })) as unknown as FakeQuery;
    const srv = await startServer(q);
    try {
      const { status } = await getBreakdown(srv.base, 'metric=latency&range=24h');
      expect(status).toBe(200);
      const [sql] = firstCall(q);
      expect(sql).toContain('AVG(avg_value)');
      expect(sql).toContain('latency_5m');
    } finally {
      await srv.close();
    }
  });

  it('short-circuits the errors metric with a warning and no query', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = makeFakeQuery();
    q.mockResolvedValue({ rows: [] });
    const srv = await startServer(q);
    try {
      const { status, body } = await getBreakdown(srv.base, 'metric=errors&range=1h');
      expect(status).toBe(200);
      expect(body).toEqual([]);
      expect(q).not.toHaveBeenCalled();
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('errors metric has no DB backing'))).toBe(true);
      warnSpy.mockRestore();
      await srv.close();
    } catch (err) {
      warnSpy.mockRestore();
      await srv.close();
      throw err;
    }
  });

  it('returns 400 without querying for an unknown metric, a derived metric, or an unknown range', async () => {
    const q = makeFakeQuery();
    q.mockResolvedValue({ rows: [] });
    const srv = await startServer(q);
    try {
      for (const qs of ['metric=bogus&range=1h', 'metric=decode_tps&range=1h', 'metric=spend&range=30d']) {
        const { status, body } = await getBreakdown(srv.base, qs);
        expect(status).toBe(400);
        expect(typeof body.error).toBe('string');
      }
      expect(q).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Routing — /api/kpis and /api/breakdown alongside the untouched /api/series
// ---------------------------------------------------------------------------

describe('routing — kpis/breakdown dispatch without disturbing /api/series', () => {
  it('404s an unknown path and a non-GET request, without querying', async () => {
    const q = makeFakeQuery();
    q.mockResolvedValue({ rows: [] });
    const srv = await startServer(q);
    try {
      const unknown = await get(srv.base, '/api/nope');
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('not found');

      const res = await fetch(`${srv.base}/api/kpis?range=1h`, { method: 'POST' });
      expect(res.status).toBe(404);
      const postBody = (await res.json()) as { error?: string };
      expect(postBody.error).toBe('not found');
      expect(q).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('leaves /api/series issuing exactly its six queries', async () => {
    const q = makeFakeQuery();
    q.mockResolvedValue({ rows: [] });
    const srv = await startServer(q);
    try {
      const { status } = await getSeries(srv.base, 'metric=requests&range=1h&group=model');
      expect(status).toBe(200);
      expect(q).toHaveBeenCalledTimes(6);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// server.ts source guard — KPI/breakdown surface, no-source nulls, no
// hardcoded production names in the new code either
// ---------------------------------------------------------------------------

describe('server.ts source guard — kpis/breakdown surface', () => {
  const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

  const forbidden = ['orchestration', 'vision-tools', 'qwen', 'tools'];

  for (const name of forbidden) {
    it(`does not contain the production name '${name}'`, () => {
      expect(src).not.toContain(name);
    });
  }

  it('contains buildKpiTotalSql (positive control: the KPI section exists)', () => {
    expect(src).toContain('buildKpiTotalSql');
  });

  it('contains buildBreakdownSql (positive control: the breakdown section exists)', () => {
    expect(src).toContain('buildBreakdownSql');
  });

  it('contains countHealthyDeployments (positive control: health counting is real)', () => {
    expect(src).toContain('countHealthyDeployments');
  });

  it('emits error_rate as a literal null (no DB backing, never fabricated)', () => {
    expect(src).toContain('error_rate: null');
  });

  it('emits p95_ms as a literal null (no DB backing, never fabricated)', () => {
    expect(src).toContain('p95_ms: null');
  });
});
