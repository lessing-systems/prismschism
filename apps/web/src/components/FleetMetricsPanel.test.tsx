// Hermetic contract tests for the rewritten FleetMetricsPanel.
//
// The panel is prop-less and pulls its series via useSeries():
//   * requestsByModel     = useSeries("requests",    "1h", "model")
//   * errorsByProvider    = useSeries("errors",      "1h", "api_provider")
//   * decodeByDeployment  = useSeries("decode_tps",  "1h", "model_id")
//   * inputByDeployment   = useSeries("input_tps",   "1h", "model_id")
// plus three OPTIONAL series (decode/input by `model`, requests_per_min by `model_id`)
// that only decorate existing cards. They stay unseeded unless a test asks for
// them — the mock's unseeded default IS the "absent series" path.
// It renders ONE card per top-N group (selectTopGroups) inside each of its two
// stacked sections: "Front-end Models" (requests + errors + the requests
// legend) and "Back-end Deployments" (decode + input-token throughput per
// deployment, ranked with deploymentLabel so labels take the composed
// `model_id · litellm_model_name` form and can never be "unlabeled").
//
// Two modules are mocked so the test is fully deterministic under jsdom:
//   * `recharts`          — jsdom has no ResizeObserver, so ResponsiveContainer
//                           collapses to 0x0 and renders no inner marks. We mock
//                           the primitives (same pattern as StatusSeriesChart).
//   * `@/lib/queries`     — useSeries returns a controlled
//                           { isLoading, isError, data } via a mutable hoisted map,
//                           keyed by (metric, range, group).
//
// No production secrets are involved — fixtures are synthetic MetricPoint arrays.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// --- recharts mock (follows StatusSeriesChart.test.tsx) ---------------------
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

// --- @/lib/queries mock: controlled series state via a mutable hoisted map --
import type { MetricPoint } from '@/lib/types';

interface SeriesResult {
  isLoading: boolean;
  isError: boolean;
  data: MetricPoint[] | undefined;
}

const seriesState = vi.hoisted(() => ({
  byKey: new Map<string, SeriesResult>(),
}));

function keyFor(metric: string, range: string, group?: string): string {
  return `${metric}|${range}|${group ?? ''}`;
}

vi.mock('@/lib/queries', () => ({
  useSeries: (metric: string, range: string, group?: string): SeriesResult => {
    return (
      seriesState.byKey.get(keyFor(metric, range, group)) ?? {
        isLoading: false,
        isError: false,
        data: undefined,
      }
    );
  },
  // The panel reads scrape health from a side-channel store in lib/api.ts. No real
  // fetch ever lands under test, so the snapshot is always null and the scrape
  // banner renders nothing. Stubbed because the whole module is mocked.
  useScrapeStatus: () => null,
}));

import { BACKEND_GRID, FleetMetricsPanel, FRONTEND_GRID } from '@/components/FleetMetricsPanel';
import { ERROR_SENTINEL, type MetricPoint as MP } from '@/lib/types';

// Fixture groups (production-shaped), with distinct totals so ranking is unique
// except for the intended orchestration/halogen tie (alphabetical tie-break).
const REQUESTS_TOTALS: Record<string, number> = {
  'Qwen3.8-27B-Q3_K_M.gguf': 500,
  'halogen-qwen3.8-flash-next': 350,
  orchestration: 350,
  tools: 120,
  'vision-tools': 80,
  openai: 20,
  None: 5,
  '': 40,
};

const ERRORS_TOTALS: Record<string, number> = {
  None: 200,
  openai: 150,
  'Qwen3.8-27B-Q3_K_M.gguf': 100,
  orchestration: 50,
  'vision-tools': 10,
  '': 5,
  tools: 0,
  'halogen-qwen3.8-flash-next': 0,
};

function makeSeries(totals: Record<string, number>): MP[] {
  const out: MP[] = [];
  for (const [group, total] of Object.entries(totals)) {
    const half = Math.floor(total / 2);
    out.push({ t: 't1', group, value: half });
    out.push({ t: 't2', group, value: total - half });
  }
  return out;
}

function setRequests(result: SeriesResult) {
  seriesState.byKey.set(keyFor('requests', '1h', 'model'), result);
}
function setErrors(result: SeriesResult) {
  seriesState.byKey.set(keyFor('errors', '1h', 'api_provider'), result);
}
function setDeployments(result: SeriesResult) {
  seriesState.byKey.set(keyFor('decode_tps', '1h', 'model_id'), result);
}

// The panel's fixed range, mirrored here so the back-end card-label assertions
// read the way the component now builds them: `${label} (${RANGE})`.
const RANGE = '1h';

// Secondary / optional series. Deliberately NOT seeded in beforeEach: the queries
// mock resolves an unseeded key to {isLoading:false,isError:false,data:undefined}
// which is exactly the "absent" path, so every pre-existing test keeps exercising
// the degraded stats ("—") and the missing optional graph.
function setPrefillDeployments(result: SeriesResult) {
  seriesState.byKey.set(keyFor('input_tps', '1h', 'model_id'), result);
}
function setDecodeByModel(result: SeriesResult) {
  seriesState.byKey.set(keyFor('decode_tps', '1h', 'model'), result);
}
function setPrefillByModel(result: SeriesResult) {
  seriesState.byKey.set(keyFor('input_tps', '1h', 'model'), result);
}
// Feeds the back-end card's "Req/min" stat, which now reads the dedicated
// requests_per_min metric grouped by model_id.
function setRequestsByDeployment(result: SeriesResult) {
  seriesState.byKey.set(keyFor('requests_per_min', '1h', 'model_id'), result);
}

// --- deployment-side fixtures ----------------------------------------------
// Deployment series are keyed by model_id and every point carries the
// LiteLLM-facing `litellm_model_name` of that deployment, which is what lets the
// panel compose `model_id · litellm_model_name` labels. Values are decode
// tokens/sec.
interface DeploymentFixture {
  modelId: string;
  name?: string;
  total: number;
}

function makeDeploymentSeries(fixtures: DeploymentFixture[]): MP[] {
  const out: MP[] = [];
  for (const f of fixtures) {
    const half = Math.floor(f.total / 2);
    const points: MP[] = [
      { t: 't1', group: f.modelId, value: half },
      { t: 't2', group: f.modelId, value: f.total - half },
    ];
    if (f.name !== undefined) {
      for (const p of points) p.litellm_model_name = f.name;
    }
    out.push(...points);
  }
  return out;
}

// Distinct totals so ranking is unambiguous. Deliberately covers the three
// shapes the deployment labeler must handle: a normal model_id + name pair, a
// model_id with NO name (label falls back to the bare model_id), and an EMPTY
// model_id (a data defect that must surface as "unknown-deployment", never
// "unlabeled").
const DEPLOYMENTS: DeploymentFixture[] = [
  { modelId: 'orchestration-qwen38', name: 'halogen-qwen3.8-flash-next', total: 900 },
  { modelId: 'orchestration-qwen38-b', name: 'halogen-qwen3.8-flash-next', total: 700 },
  { modelId: 'vision-tools-4b', name: 'vision-tools-qwen3-vl', total: 500 },
  { modelId: 'tools-moe', name: 'tools-moe-a3b', total: 300 },
  { modelId: 'legacy-no-name', total: 200 },
  { modelId: '', name: 'orphaned-name', total: 100 },
];

// Expected top-6 deployment card labels, ranked by decode total descending.
const EXPECTED_TOP6_DEPLOYMENTS = [
  'orchestration-qwen38 · halogen-qwen3.8-flash-next',
  'orchestration-qwen38-b · halogen-qwen3.8-flash-next',
  'vision-tools-4b · vision-tools-qwen3-vl',
  'tools-moe · tools-moe-a3b',
  'legacy-no-name',
  'unknown-deployment',
];

// Expected top-6 requests groups (by total desc, alphabetical on the 350 tie).
const EXPECTED_TOP6 = [
  'Qwen3.8-27B-Q3_K_M.gguf',
  'halogen-qwen3.8-flash-next',
  'orchestration',
  'tools',
  'vision-tools',
  'unlabeled', // "" group -> label "unlabeled"
];
const EXPECTED_TOP6_ERRORS = [
  'None',
  'openai',
  'Qwen3.8-27B-Q3_K_M.gguf',
  'orchestration',
  'vision-tools',
  'unlabeled',
];

function legendLabelOrder(): string[] {
  const legend = screen.getByTestId('fleet-legend');
  return Array.from(legend.children).map((el) => (el as HTMLElement).textContent ?? '');
}

beforeEach(() => {
  seriesState.byKey.clear();
  // Seed the deployment series resolved-with-data so pre-existing tests never
  // sit in the new three-series loading gate. Individual tests override it.
  setDeployments({
    isLoading: false,
    isError: false,
    data: makeDeploymentSeries(DEPLOYMENTS),
  });
  cleanup();
});

describe('FleetMetricsPanel — dynamic top-N rendering', () => {
  it('renders one card per top-N requests group, in top order', () => {
    setRequests({ isLoading: false, isError: false, data: makeSeries(REQUESTS_TOTALS) });
    setErrors({ isLoading: false, isError: false, data: makeSeries(ERRORS_TOTALS) });
    const { container } = render(<FleetMetricsPanel />);

    // Every expected top-6 requests group label is present in the cards.
    for (const label of EXPECTED_TOP6) {
      expect(container.textContent).toContain(`${label} · requests (1h)`);
    }

    // The legend lists the same groups, in the exact top order.
    expect(legendLabelOrder()).toEqual(EXPECTED_TOP6);
  });

  it('renders the empty-string group as "unlabeled" in both labels and legend', () => {
    setRequests({ isLoading: false, isError: false, data: makeSeries(REQUESTS_TOTALS) });
    setErrors({ isLoading: false, isError: false, data: makeSeries(ERRORS_TOTALS) });
    const { container } = render(<FleetMetricsPanel />);

    // Card label for the "" group reads "unlabeled", never the raw empty string.
    expect(container.textContent).toContain('unlabeled · requests (1h)');
    expect(container.textContent).toContain('unlabeled · errors (1h)');
    // Legend shows "unlabeled" and never a bare empty token.
    expect(legendLabelOrder()).toContain('unlabeled');
  });

  it('legend (fleet-legend) lists the dynamic group names with a color swatch each', () => {
    setRequests({ isLoading: false, isError: false, data: makeSeries(REQUESTS_TOTALS) });
    setErrors({ isLoading: false, isError: false, data: makeSeries(ERRORS_TOTALS) });
    const { container } = render(<FleetMetricsPanel />);

    const legend = screen.getByTestId('fleet-legend');
    expect(legend.getAttribute('role')).toBe('list');

    const items = Array.from(legend.children);
    expect(items.length).toBe(EXPECTED_TOP6.length); // one entry per top group
    // Each legend entry carries a swatch cycling the six --legend-N tokens.
    items.forEach((el, i) => {
      const swatch = (el as HTMLElement).querySelector('[data-testid="legend-swatch"]');
      expect(swatch, `swatch missing at index ${i}`).not.toBeNull();
      expect((swatch as HTMLElement).style.backgroundColor).toBe(
        `hsl(var(--legend-${(i % 6) + 1}))`,
      );
    });
    void container;
  });

  it('contains NO hardcoded mock-era model names (gpt-4o / gpt-4-turbo)', () => {
    setRequests({ isLoading: false, isError: false, data: makeSeries(REQUESTS_TOTALS) });
    setErrors({ isLoading: false, isError: false, data: makeSeries(ERRORS_TOTALS) });
    const { container } = render(<FleetMetricsPanel />);
    expect(container.textContent).not.toMatch(/gpt-4o|gpt-4-turbo/);
  });
});

describe('FleetMetricsPanel — sentinel exclusion feeds ranking', () => {
  it('excludes ERROR_SENTINEL points; a sentinel-only group is dropped (no slot, no legend entry)', () => {
    // 'real' = 100 (2x50). 'fake' = 4 sentinel points only (no real data).
    // If sentinels were counted, 'fake' would total 100 and steal a slot.
    const series: MP[] = [
      { t: 't1', group: 'real', value: 50 },
      { t: 't2', group: 'real', value: 50 },
      { t: 't1', group: 'fake', value: ERROR_SENTINEL },
      { t: 't2', group: 'fake', value: ERROR_SENTINEL },
      { t: 't3', group: 'fake', value: ERROR_SENTINEL },
      { t: 't4', group: 'fake', value: ERROR_SENTINEL },
    ];
    setRequests({ isLoading: false, isError: false, data: series });
    setErrors({ isLoading: false, isError: false, data: [] });
    const { container } = render(<FleetMetricsPanel />);

    // 'real' is the ONLY group with real data -> the sole card + legend entry.
    const order = legendLabelOrder();
    expect(order).toEqual(['real']);
    expect(order.indexOf('fake')).toBe(-1); // 'fake' dropped entirely
    expect(container.textContent).not.toContain('fake');
  });
});

describe('FleetMetricsPanel — empty / error states', () => {
  it('renders the "No data" empty state when a resolved series has no groups (no crash)', () => {
    // data: [] -> selectTopGroups -> [] -> empty state (all THREE series empty).
    setRequests({ isLoading: false, isError: false, data: [] });
    setErrors({ isLoading: false, isError: false, data: [] });
    setDeployments({ isLoading: false, isError: false, data: [] });
    render(<FleetMetricsPanel />);
    expect(screen.getByTestId('fleet-empty')).toBeDefined();
    expect(screen.getByTestId('fleet-empty').textContent).toBe('No data');
    expect(screen.queryByTestId('fleet-legend')).toBeNull();
  });

  it('renders the "No data" empty state when series data is undefined (no crash)', () => {
    // data: undefined (TanStack resolved-to-undefined) -> still the empty state.
    setRequests({ isLoading: false, isError: false, data: undefined });
    setErrors({ isLoading: false, isError: false, data: undefined });
    setDeployments({ isLoading: false, isError: false, data: undefined });
    render(<FleetMetricsPanel />);
    expect(screen.getByTestId('fleet-empty')).toBeDefined();
  });

  it('shows the loading skeleton (regression guard) when a series is loading', () => {
    setRequests({ isLoading: true, isError: false, data: undefined });
    setErrors({ isLoading: true, isError: false, data: undefined });
    const { container } = render(<FleetMetricsPanel />);
    // The 240px pulsing skeleton uses class animate-pulse.
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    // No chart, no legend, no empty state while loading.
    expect(screen.queryByTestId('fleet-legend')).toBeNull();
    expect(screen.queryByTestId('fleet-empty')).toBeNull();
    expect(container.querySelector('[data-testid="line-chart"]')).toBeNull();
  });

  it('shows the destructive failure message (regression guard) when a series errors', () => {
    setRequests({ isLoading: false, isError: true, data: undefined });
    setErrors({ isLoading: false, isError: false, data: makeSeries(ERRORS_TOTALS) });
    const { container } = render(<FleetMetricsPanel />);
    // The failing requests card shows the destructive text.
    const destructive = container.querySelector('.text-destructive');
    expect(destructive).not.toBeNull();
    expect((destructive as HTMLElement).textContent).toContain('Failed to load');
    // A valid errors series still renders its cards alongside the failed one.
    expect(container.textContent).toContain(`${EXPECTED_TOP6_ERRORS[0]} · errors (1h)`);
  });
});

describe('FleetMetricsPanel — two stacked sections', () => {
  function sections() {
    return {
      frontend: screen.getByTestId('frontend-section'),
      backend: screen.getByTestId('backend-section'),
    };
  }

  function populated() {
    setRequests({ isLoading: false, isError: false, data: makeSeries(REQUESTS_TOTALS) });
    setErrors({ isLoading: false, isError: false, data: makeSeries(ERRORS_TOTALS) });
  }

  it('renders a front-end and a back-end section, front-end first in the DOM', () => {
    populated();
    render(<FleetMetricsPanel />);

    const { frontend, backend } = sections();
    expect(frontend.querySelector('h2')?.textContent).toBe('Model Groups');
    expect(backend.querySelector('h2')?.textContent).toBe('Back-end Deployments');
    // DOM order, not just presence: front-end precedes back-end.
    expect(
      frontend.compareDocumentPosition(backend) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The panel-level heading still sits above both sub-headers.
    expect(screen.getByText('Fleet Metrics')).toBeDefined();
    // The requests legend belongs to the front-end section.
    expect(frontend.querySelector('[data-testid="fleet-legend"]')).not.toBeNull();
    expect(backend.querySelector('[data-testid="fleet-legend"]')).toBeNull();
  });

  it('renders one deployment card per top group, sorted by family then model_id', () => {
    populated();
    render(<FleetMetricsPanel />);

    const { backend, frontend } = sections();
    const text = backend.textContent ?? '';
    // Ranking still decides WHICH groups appear; display order is family then
    // model_id, with the missing-model_id card (unknown-deployment) last.
    const sorted = [
      'legacy-no-name',
      'orchestration-qwen38 · halogen-qwen3.8-flash-next',
      'orchestration-qwen38-b · halogen-qwen3.8-flash-next',
      'tools-moe · tools-moe-a3b',
      'vision-tools-4b · vision-tools-qwen3-vl',
      'unknown-deployment',
    ];
    expect([...sorted].sort()).toEqual([...EXPECTED_TOP6_DEPLOYMENTS].sort());
    let last = -1;
    for (const label of sorted) {
      const card = `${label} (${RANGE})`;
      const at = text.indexOf(card);
      expect(at, `missing deployment card: ${card}`).toBeGreaterThan(-1);
      expect(at, `deployment cards out of name order: ${card}`).toBeGreaterThan(last);
      last = at;
    }
    // Each family gets its own row (own grid).
    const families = Array.from(backend.querySelectorAll('[data-testid="backend-family"]'));
    const famNames = families.map((f) => f.querySelector('h3')?.textContent ?? '');
    expect(famNames).toEqual(['legacy', 'orchestration', 'tools', 'vision', 'unknown']);
    // Deployment cards live in the back-end section only.
    expect(frontend.textContent).not.toContain('decode t/s (1h)');
  });

  it('labels deployment cards with the composed `model_id · litellm_model_name` form', () => {
    populated();
    render(<FleetMetricsPanel />);

    const { backend } = sections();
    expect(backend.textContent).toContain(
      'orchestration-qwen38 · halogen-qwen3.8-flash-next (1h)',
    );
    // A deployment with no litellm_model_name falls back to the BARE model_id —
    // never a dangling "id · ".
    expect(backend.textContent).toContain('legacy-no-name (1h)');
    expect(backend.textContent).not.toMatch(/·\s*·/);
  });

  it('never renders "unlabeled" in the back-end section, even when the request side has one', () => {
    populated();
    render(<FleetMetricsPanel />);

    const { backend, frontend } = sections();
    // The fixture deliberately includes an EMPTY model_id group; its fallback is
    // the deployment sentinel, never the request-side "unlabeled".
    expect(backend.textContent).not.toContain('unlabeled');
    expect(backend.textContent).toContain('unknown-deployment (1h)');
    // Request-side "" -> "unlabeled" is unchanged and stays in the front-end section.
    expect(frontend.textContent).toContain('unlabeled · requests (1h)');
  });

  it('isolates a deployment-series error to the back-end section', () => {
    populated();
    setDeployments({ isLoading: false, isError: true, data: undefined });
    render(<FleetMetricsPanel />);

    const { backend, frontend } = sections();
    expect(backend.querySelector('.text-destructive')).not.toBeNull();
    expect(backend.textContent).toContain('Failed to load');
    // The front-end section is untouched by the deployment failure.
    expect(frontend.querySelector('[data-testid="line-chart"]')).not.toBeNull();
    expect(frontend.textContent).toContain(`${EXPECTED_TOP6[0]} · requests (1h)`);
    expect(frontend.textContent).toContain(`${EXPECTED_TOP6_ERRORS[0]} · errors (1h)`);
    // A failed series charts no deployment cards.
    expect(screen.queryAllByTestId('deployment-card')).toHaveLength(0);
  });

  it('shows fleet-empty only when all three series resolved empty', () => {
    setRequests({ isLoading: false, isError: false, data: [] });
    setErrors({ isLoading: false, isError: false, data: [] });
    setDeployments({ isLoading: false, isError: false, data: [] });
    render(<FleetMetricsPanel />);
    expect(screen.getByTestId('fleet-empty').textContent).toBe('No data');
  });

  it('keeps the front-end section intact when only the deployment series is empty', () => {
    populated();
    setDeployments({ isLoading: false, isError: false, data: [] });
    render(<FleetMetricsPanel />);

    const { backend, frontend } = sections();
    expect(screen.queryByTestId('fleet-empty')).toBeNull();
    expect(frontend.querySelector('[data-testid="line-chart"]')).not.toBeNull();
    expect(frontend.textContent).toContain(`${EXPECTED_TOP6[0]} · requests (1h)`);
    expect(backend.querySelector('h2')?.textContent).toBe('Back-end Deployments');
    // An empty ranking series charts no deployment cards.
    expect(screen.queryAllByTestId('deployment-card')).toHaveLength(0);
  });

  it('shows the panel skeleton while only the deployment series is loading', () => {
    populated();
    setDeployments({ isLoading: true, isError: false, data: undefined });
    const { container } = render(<FleetMetricsPanel />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByTestId('frontend-section')).toBeNull();
    expect(screen.queryByTestId('backend-section')).toBeNull();
  });

  it('lays both sections out on the shared responsive card grid (1 → 2 → 3 → 4 columns)', () => {
    populated();
    render(<FleetMetricsPanel />);
    const frontendGrid = document.querySelector('[data-testid="frontend-grid"]');
    const backendGrid = document.querySelector('[data-testid="backend-grid"]');
    expect(frontendGrid).not.toBeNull();
    expect(backendGrid).not.toBeNull();
    expect(frontendGrid?.className).toBe(FRONTEND_GRID);
    expect(backendGrid?.className).toBe(BACKEND_GRID);
    expect(FRONTEND_GRID).toBe(
      'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 min-[2000px]:grid-cols-4',
    );
    expect(BACKEND_GRID).toBe(FRONTEND_GRID);
  });
});

// --- helpers shared by the new card-stats / graph-block coverage --------------
function statDl(card: Element): Element | null {
  return card.querySelector('[data-testid="card-stats"]');
}
function statLabels(card: Element): string[] {
  const dl = statDl(card);
  return dl ? Array.from(dl.querySelectorAll('dt')).map((el) => el.textContent ?? '') : [];
}
function statValues(card: Element): string[] {
  const dl = statDl(card);
  return dl ? Array.from(dl.querySelectorAll('dd')).map((el) => el.textContent ?? '') : [];
}
function backendSection(): HTMLElement {
  return screen.getByTestId('backend-section');
}
function frontendSection(): HTMLElement {
  return screen.getByTestId('frontend-section');
}
function seedRequestSide() {
  setRequests({ isLoading: false, isError: false, data: makeSeries(REQUESTS_TOTALS) });
  setErrors({ isLoading: false, isError: false, data: makeSeries(ERRORS_TOTALS) });
}

describe('FleetMetricsPanel — deployment card graphs', () => {
  it('deployment card carries two labelled graphs', () => {
    seedRequestSide();
    setPrefillDeployments({
      isLoading: false,
      isError: false,
      data: makeDeploymentSeries([
        { modelId: 'orchestration-qwen38', name: 'halogen-qwen3.8-flash-next', total: 400 },
      ]),
    });
    render(<FleetMetricsPanel />);

    const card = screen.getAllByTestId('deployment-card')[0];
    // ONE card, TWO stacked labelled graphs.
    expect(card.querySelectorAll('[data-testid="graph-block"]').length).toBeGreaterThanOrEqual(2);
    const text = backendSection().textContent ?? '';
    expect(text).toContain('Decode token/s');
    expect(text).toContain('Input token/s');
  });

  it('input-token graph degrades when input data is absent', () => {
    seedRequestSide();
    // input_tps|1h|model_id deliberately UNSEEDED -> resolved-without-data.
    render(<FleetMetricsPanel />);

    // The cards still exist: an absent secondary series never skeletons the panel.
    expect(screen.queryAllByTestId('deployment-card').length).toBeGreaterThan(0);
    expect(backendSection().textContent).toContain('No input-token data');
  });
});

describe('FleetMetricsPanel — per-card stats', () => {
  it('per-card stats render real means', () => {
    setDeployments({
      isLoading: false,
      isError: false,
      data: [
        { t: 't1', group: 'solo-dep', value: 10, litellm_model_name: 'solo-model' },
        { t: 't2', group: 'solo-dep', value: 30, litellm_model_name: 'solo-model' },
      ],
    });
    render(<FleetMetricsPanel />);

    const card = screen.getAllByTestId('deployment-card')[0];
    expect(statLabels(card)).toEqual(['Decode t/s', 'Input t/s', 'Req/min', 'Wall-clock s']);
    // mean(10, 30) = 20. The input-token and requests_per_min series are absent,
    // so both read 0: an inventory-backed back-end card always renders, and a
    // missing metric shows 0 rather than the "—" placeholder. Wall-clock is
    // absent here too but reads "—", not 0: 0 seconds is not an observation.
    expect(statValues(card)).toEqual(['20', '0', '0', '\u2014']);
  });

  it('RPM excludes idle and error buckets', () => {
    // stats.ts EXCLUDED_RPM_STATES drops idle + error buckets from rate means.
    // The "disabled" state is not modelled on MetricPoint yet (see stats.ts), so
    // it is deliberately absent from this fixture.
    setDeployments({
      isLoading: false,
      isError: false,
      data: [
        { t: 't1', group: 'dep-rpm', value: 40, litellm_model_name: 'rpm-model' },
        { t: 't2', group: 'dep-rpm', value: 40, litellm_model_name: 'rpm-model' },
      ],
    });
    setRequestsByDeployment({
      isLoading: false,
      isError: false,
      data: [
        { t: 't1', group: 'dep-rpm', value: 10, state: 'healthy' },
        { t: 't2', group: 'dep-rpm', value: 0, state: 'idle' },
        { t: 't3', group: 'dep-rpm', value: 25, state: 'error' },
        { t: 't4', group: 'dep-rpm', value: 30, state: 'healthy' },
      ],
    });
    render(<FleetMetricsPanel />);

    const card = screen.getAllByTestId('deployment-card')[0];
    // decode mean = 40; Req/min = mean(10, 30) = 20 — the idle 0 and error 25 are
    // out. The input-token series is absent, so the middle stat reads 0; the
    // wall-clock series is absent, so the last stat reads "—".
    expect(statValues(card)).toEqual(['40', '0', '20', '\u2014']);
  });
});

describe('FleetMetricsPanel — front-end card stats + optional decode graph', () => {
  const TOP_MODEL = 'Qwen3.8-27B-Q3_K_M.gguf'; // top-ranked request-side group

  it('stats row renders without the decode graph, then the graph appears', () => {
    seedRequestSide();
    // decode_tps|1h|model deliberately UNSEEDED (the dev mock never serves tps).
    render(<FleetMetricsPanel />);

    let frontend = frontendSection();
    expect(frontend.querySelectorAll('[data-testid="card-stats"]').length).toBeGreaterThan(0);
    // No group=model decode series -> no decode graph block anywhere in the
    // front-end section, and the throughput stats fall back to "—".
    expect(frontend.textContent).not.toContain('Decode token/s');
    expect(frontend.textContent).toContain('Requests');
    cleanup();

    setDecodeByModel({
      isLoading: false,
      isError: false,
      data: [
        { t: 't1', group: TOP_MODEL, value: 10 },
        { t: 't2', group: TOP_MODEL, value: 30 },
      ],
    });
    setPrefillByModel({
      isLoading: false,
      isError: false,
      data: [
        { t: 't1', group: TOP_MODEL, value: 70 },
        { t: 't2', group: TOP_MODEL, value: 80 },
      ],
    });
    render(<FleetMetricsPanel />);

    frontend = frontendSection();
    expect(frontend.textContent).toContain('Decode token/s');
    // First requests card == top-ranked model: decode mean 20, input mean 75,
    // RPM = the request mean (250). The optional wall-clock series is absent,
    // so the fourth stat reads "—".
    const firstDls = frontend.querySelectorAll('[data-testid="card-stats"]');
    expect(firstDls.length).toBeGreaterThan(0);
    const values = Array.from(firstDls[0].querySelectorAll('dd')).map(
      (el) => el.textContent ?? '',
    );
    expect(values).toEqual(['20', '75', '250', '\u2014']);
  });
});

describe('FleetMetricsPanel — fleet combined token/s', () => {
  it('sums each deployment mean and labels it "observed"', () => {
    setDeployments({
      isLoading: false,
      isError: false,
      data: [
        { t: 't1', group: 'dep-a', value: 10, litellm_model_name: 'a' },
        { t: 't2', group: 'dep-a', value: 10, litellm_model_name: 'a' },
        { t: 't1', group: 'dep-b', value: 30, litellm_model_name: 'b' },
        { t: 't2', group: 'dep-b', value: 30, litellm_model_name: 'b' },
      ],
    });
    render(<FleetMetricsPanel />);

    const el = screen.getByTestId('fleet-combined-tps');
    expect(el.textContent).toContain('Combined Token/s (observed)');
    expect(el.textContent).toContain('40'); // 10 + 30, summed across deployments
  });

  it('shows "—" instead of 0 when there is no decode data', () => {
    setDeployments({ isLoading: false, isError: false, data: [] });
    render(<FleetMetricsPanel />);

    const el = screen.getByTestId('fleet-combined-tps');
    expect(el.textContent).toContain('\u2014');
    expect(el.textContent).not.toContain('0');
  });
});
