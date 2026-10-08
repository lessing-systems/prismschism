// Fleet-level metric series, rendered dynamically from the top-N groups.
//
// The panel takes one optional prop, `range` (default "1h"). It pulls four full
// (grouped-by-dimension) series:
//   * requestsByModel     = useSeries("requests",    range, "model")
//   * errorsByProvider    = useSeries("errors",      range, "api_provider")
//   * decodeByDeployment  = useSeries("decode_tps",  range, "model_id")
//   * inputByDeployment   = useSeries("input_tps",   range, "model_id")
// plus three OPTIONAL enrichment series (decode/input by `model`, requests-per-
// `model_id`) that only decorate cards that already exist and never gate the
// panel. Displayed groups are derived at render time via selectTopGroups() — the
// leading n groups by aggregated REAL value (sentinel points excluded).
//
// LAYOUT, top to bottom:
//   * Fleet summary strip — "Combined Token/s (observed)" (the sum of each
//     deployment's own average decode t/s), back-end state counts (latest
//     bucket per deployment), front-end model count, and the window's peak
//     decode bucket. Everything is derived from series already fetched here.
//   * "Front-end Models"     — the request side: one card per top model with a
//     stats row (Avg Decode t/s, Input t/s, RPM), a "Requests" graph, and a
//     "Decode token/s" graph whenever group=model decode data exists; then the
//     errors-by-provider state-bar cards.
//   * "Back-end Deployments" — the deployment side: ONE card per top deployment
//     group carrying the same stats row plus TWO stacked graphs, "Decode
//     token/s" and "Input token/s".
// Every card header carries the group's latest traffic-light state as a badge.
//
// Every stat goes through lib/stats.ts: means never re-add excluded buckets and
// a series with no numeric data renders "—", never 0.
//
// The two sides rank with different labelers because their `group` means
// different things. Request-side groups are already display names, so they keep
// the default requestLabel ("" -> "unlabeled"). Deployment-side groups are
// model_ids, so they rank with deploymentLabel, which composes
// `model_id · litellm_model_name` and can NEVER emit "unlabeled" — a missing
// model_id is a data defect and surfaces as UNKNOWN_DEPLOYMENT instead.
//
// Series colors cycle the six dedicated --legend-N categorical tokens so every
// displayed group gets a distinct color. The legend
// scale is deliberately kept distinct from the traffic-light tokens, so a series
// swatch can never be misread as a health state.
//
// Loading -> pulsing skeleton. Error -> compact destructive message.
// Empty (no groups in ANY series) -> "No data".
//
// While a gated series is still loading the top-N groups are unknown, so a
// panel-level skeleton holds the slot. Error handling stays per-series: a series
// that resolved as an error renders its own "Failed to load" card while sibling
// series that did load still chart — including across the section boundary, so
// a dead deployment series never takes the front-end section down (or vice versa).

import type { ReactNode } from "react";
import { useScrapeStatus, useSeries } from "@/lib/queries";
import { MetricLineChart } from "@/components/charts/MetricLineChart";
import { StateBarChart } from "@/components/charts/StateBarChart";
import { StateBadge, StateDot, StateLegend } from "@/components/StateIndicator";
import { currentState } from "@/lib/currentState";
import {
  combinedObservedTokenRate,
  maxCombinedTokenRate,
  formatStat,
  meanExcludingStates,
  meanOf,
  meanOfActive,
} from "@/lib/stats";
import {
  deploymentLabel,
  LEGEND_MAX,
  PANEL_TOP_N,
  selectTopGroups,
  type GroupLabeler,
  type TopGroup,
} from "@/lib/topGroups";
import { isDebugEnabled, UNASSIGNED_GROUP } from "@/lib/debug";
import { groupByFamily } from "@/lib/deploymentFamilies";
import { stateToken } from "@/components/charts/stateTokens";
import { cn } from "@/lib/utils";
import type { MetricPoint, MetricPointState, Range } from "@/lib/types";

// Chart slot heights. Skeletons hold the same slot to avoid layout shift.
const FRONTEND_CHART_PX = 168;
const BACKEND_CHART_PX = 128;

export const FRONTEND_GRID =
  "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 min-[2000px]:grid-cols-4";
export const BACKEND_GRID =
  "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 min-[2000px]:grid-cols-4";

type UseSeriesResult = ReturnType<typeof useSeries>;

// The API ALWAYS emits the "unassigned" group and never filters it server-side,
// so the client owns its visibility: it is a debug-only card (VITE_DEBUG).
function dropUnassigned(points: MetricPoint[]): MetricPoint[] {
  return points.filter((p) => p.group !== UNASSIGNED_GROUP);
}

// A series' points as they may be displayed: everything when the debug flag is on,
// with "unassigned" removed when it is off.
function visibleSeries(points: MetricPoint[] | null | undefined): MetricPoint[] {
  const series = points ?? [];
  return isDebugEnabled() ? series : dropUnassigned(series);
}

// Ghost-proof the points that feed rate-style fleet sums (combined tiles): keep
// only groups the classifier/roster vouches for. `in_inventory` is false on
// metric-only groups (present in metrics, absent from deployment_inventory —
// retired model_ids, LiteLLM aliases, scrape artifacts) and absent on axes
// without an inventory column (api_provider), which are kept. Combined with
// visibleSeries, neither "unassigned" nor ghost data can reach a fleet sum.
function rosteredVisible(points: MetricPoint[] | null | undefined): MetricPoint[] {
  return visibleSeries(points).filter((p) => p.in_inventory !== false);
}

// Leading n groups for a (possibly still-loading/errored) series. The labeler
// defaults to requestLabel (request-side); deployment-side callers pass
// deploymentLabel so "unlabeled" is structurally impossible there.
function topOf(
  query: UseSeriesResult,
  labeler?: GroupLabeler,
  n: number = PANEL_TOP_N,
): TopGroup[] {
  return selectTopGroups(visibleSeries(query.data), n, labeler);
}

// Inventory-backed backends must never be silently dropped by the top-N cut: any
// group carrying `in_inventory: true` that ranking left behind is appended — zeros
// included — sorted by total desc then group asc, exactly like the ranker.
function withInventory(
  ranked: TopGroup[],
  points: MetricPoint[],
  labeler: GroupLabeler,
): TopGroup[] {
  const seen = new Set(ranked.map((g) => g.group));
  const totals = new Map<string, number>();
  for (const p of points) {
    if (p.in_inventory !== true || seen.has(p.group)) continue;
    const v = typeof p.value === "number" && Number.isFinite(p.value) ? p.value : 0;
    totals.set(p.group, (totals.get(p.group) ?? 0) + v);
  }
  if (totals.size === 0) return ranked;
  const extra: TopGroup[] = [];
  for (const [group, total] of totals) {
    extra.push({ group, label: labeler(group, { points }), total });
  }
  extra.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.group < b.group) return -1;
    if (a.group > b.group) return 1;
    return 0;
  });
  return [...ranked, ...extra];
}

// Debug-only: pin the "unassigned" card to the end of the list so it is visible
// whenever the flag is on, even at zero traffic and even outside the top-N cut.
function withUnassigned(groups: TopGroup[], points: MetricPoint[]): TopGroup[] {
  if (!isDebugEnabled()) return groups;
  if (groups.some((g) => g.group === UNASSIGNED_GROUP)) return groups;
  if (!points.some((p) => p.group === UNASSIGNED_GROUP)) return groups;
  return [...groups, { group: UNASSIGNED_GROUP, label: UNASSIGNED_GROUP, total: 0 }];
}

// The points belonging to one group of a (possibly unresolved) series. An
// unresolved or errored series has no data, so every group filters to [].
function pointsFor(query: UseSeriesResult, group: string): MetricPoint[] {
  return query.data?.filter((p) => p.group === group) ?? [];
}

// Back-end stats read 0 — never the "—" placeholder — when their series is
// missing, empty, or scrape-down filler: the card must always render, and the
// blue --error traffic light on the chart is what tells the operator that the 0 is
// not a measurement.
function statOrZero(value: number | null, maximumFractionDigits: number): string {
  return formatStat(value ?? 0, maximumFractionDigits);
}

const legendColor = (i: number) => `hsl(var(--legend-${(i % 6) + 1}))`;

// ── Building blocks ────────────────────────────────────────────────────────

function Skeleton({ height, className }: { height: number; className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted", className)} style={{ height }} />;
}

function InlineError({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <span aria-hidden="true">!</span>
      {children}
    </div>
  );
}

// Card header: series swatch + title (+ optional mono subtitle), a caption
// naming what is charted, and the group's latest traffic-light state.
function CardHeader({
  title,
  fullLabel,
  subtitle,
  caption,
  swatch,
  state,
}: {
  title: string;
  /** Screen-reader name for the card, e.g. "tools · requests (1h)". */
  fullLabel: string;
  subtitle?: string;
  caption: string;
  swatch?: string;
  state?: MetricPointState;
}) {
  return (
    <div data-testid="card-header" className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {swatch && (
            <span
              aria-hidden="true"
              className="inline-block h-3 w-1 shrink-0 rounded-full"
              style={{ backgroundColor: swatch }}
            />
          )}
          <h3 className="truncate text-sm font-semibold tracking-tight text-foreground" title={fullLabel}>
            <span aria-hidden="true">{title}</span>
            <span className="sr-only">{fullLabel}</span>
          </h3>
        </div>
        {subtitle && (
          <div className="mt-0.5 truncate pl-3 font-mono text-[11px] text-muted-foreground" title={subtitle}>
            {subtitle}
          </div>
        )}
        <div className={cn("mt-0.5 text-[11px] text-muted-foreground/80", swatch && "pl-3")}>{caption}</div>
      </div>
      {state !== undefined && <StateBadge state={state} />}
    </div>
  );
}

// One compact stats row per card. Callers pass values already run through
// formatStat(), so a stat with no numeric data reads "—" and never 0.
function CardStats({ stats }: { stats: { label: string; value: string }[] }) {
  return (
    <dl
      data-testid="card-stats"
      className="mb-3 grid grid-cols-3 divide-x divide-border overflow-hidden rounded-lg border border-border bg-muted/50"
    >
      {stats.map((s) => (
        <div key={s.label} className="flex min-w-0 flex-col-reverse px-3 py-2">
          <dt className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {s.label}
          </dt>
          <dd className="text-lg font-semibold leading-tight tabular-nums text-foreground">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// A labelled graph slot inside a card.
function GraphBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-testid="graph-block" className="mt-3 first:mt-0">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

// An OPTIONAL series that resolved with nothing to chart: hold the chart slot and
// say why, instead of painting an empty axis.
function NoSeriesData({ note, height }: { note: string; height: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground"
      style={{ height }}
    >
      {note}
    </div>
  );
}

// Legend for the requests groups. Each entry carries a swatch cycling the six
// categorical tokens; the "" group reads as "unlabeled".
function Legend({ groups }: { groups: TopGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <ul
      data-testid="fleet-legend"
      role="list"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
    >
      {groups.map((g, i) => (
        <li key={g.group} className="flex items-center gap-1.5">
          <span
            data-testid="legend-swatch"
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: `hsl(var(--legend-${(i % 6) + 1}))` }}
          />
          {g.label}
        </li>
      ))}
    </ul>
  );
}

function SectionHeader({
  title,
  count,
  description,
  aside,
}: {
  title: string;
  count?: number;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
          {count !== undefined && (
            <span className="rounded-full border border-border bg-card px-2 py-px text-[11px] font-medium tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {aside}
    </div>
  );
}

// Series-level error card: an errored series has no groups to chart, so the
// failure is reported once for the whole series (not per-group).
function SeriesErrorCard({ title }: { title: string }) {
  return (
    <div className="surface p-4">
      <div className="mb-3 text-sm font-semibold text-foreground">{title}</div>
      <InlineError>Failed to load {title}</InlineError>
    </div>
  );
}

// ── Fleet summary strip ─────────────────────────────────────────────────────

// 12px inline info glyph for tile tooltips (stroke inherits currentColor).
function InfoGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-3 w-3">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 7.25v3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
    </svg>
  );
}

function SummaryTile({
  label,
  value,
  unit,
  detail,
  info,
  accent,
  testId,
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  detail?: ReactNode;
  /** Long-form explanation, shown as a tooltip on an info glyph next to the
   *  label (hover or keyboard focus). The visible `detail` line stays short. */
  info?: string;
  accent?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("surface relative px-5 py-4", accent && "border-brand/40")}
    >
      {accent && (
        // The gradient is clipped in its own layer so the tile root can stay
        // overflow-visible — the info tooltip must be able to leave the card.
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
          <div
            className="absolute inset-0"
            style={{
              background: "radial-gradient(420px 140px at 0% 0%, hsl(var(--brand) / 0.16), transparent 70%)",
            }}
          />
        </div>
      )}
      <div className="relative">
        <div className="eyebrow flex items-center gap-1.5">
          <span className="truncate">{label}</span>
          {info && (
            <span
              tabIndex={0}
              role="note"
              aria-label={info}
              className="group/info relative inline-flex shrink-0 cursor-help text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
            >
              <InfoGlyph />
              <span
                role="tooltip"
                className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 w-60 -translate-x-1/2 rounded-lg border border-border bg-card px-2.5 py-2 text-[11px] font-medium normal-case leading-snug tracking-normal text-muted-foreground opacity-0 shadow-lg transition-opacity duration-150 group-hover/info:opacity-100 group-focus-within/info:opacity-100"
              >
                {info}
              </span>
            </span>
          )}
        </div>
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">{value}</span>
          {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
        </div>
        {detail && <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

const STATE_ORDER: MetricPointState[] = ["healthy", "prefill", "error", "idle"];
const STATE_WORD: Record<MetricPointState, string> = {
  healthy: "streaming",
  prefill: "prefill",
  error: "error",
  idle: "idle",
};

function StateMix({ states }: { states: (MetricPointState | undefined)[] }) {
  const counts = new Map<MetricPointState, number>();
  for (const s of states) if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  const total = states.length;
  if (total === 0) return null;
  return (
    <div className="mt-3">
      <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
        {STATE_ORDER.filter((s) => counts.has(s)).map((s) => (
          <span
            key={s}
            style={{ flexGrow: counts.get(s), backgroundColor: stateToken(s) }}
            className="h-full"
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {STATE_ORDER.filter((s) => counts.has(s)).map((s) => (
          <span key={s} className="flex items-center gap-1">
            <StateDot state={s} size="sm" />
            <span className="tabular-nums text-foreground">{counts.get(s)}</span> {STATE_WORD[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

function peakOf(points: MetricPoint[]): { value: number; group: string } | null {
  let best: { value: number; group: string } | null = null;
  for (const p of points) {
    if (p.state === "error" || p.synthetic) continue;
    if (typeof p.value !== "number" || !Number.isFinite(p.value)) continue;
    if (!best || p.value > best.value) best = { value: p.value, group: p.group };
  }
  return best;
}

// ── Scrape-down banner ──────────────────────────────────────────────────────
// Once no scrape has succeeded for 75s the API stamps every point
// state:"error" + value:0 + synthetic:true. The charts already paint those points
// with the blue --error token; this banner adds the missing "how stale" context,
// read from the X-Scrape-* response headers captured in lib/api.ts. Those headers
// are readable because every fetch goes to the same-origin "/api" base (the Vite
// dev proxy forwards /api -> http://api:8080), so no CORS exposure change is
// needed in the API.
const SCRAPE_DOWN_MS = 75_000;

function formatStaleness(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function ScrapeBanner() {
  const scrape = useScrapeStatus();
  if (!scrape) return null;
  const staleness = scrape.stalenessMs ?? 0;
  if (!scrape.down && staleness < SCRAPE_DOWN_MS) return null;
  return (
    <div
      data-testid="scrape-banner"
      role="status"
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 text-xs text-muted-foreground"
      style={{
        borderColor: "hsl(var(--error) / 0.45)",
        background: "linear-gradient(90deg, hsl(var(--error) / 0.14), hsl(var(--error) / 0.04))",
      }}
    >
      <StateDot state="error" />
      <span className="text-sm font-semibold text-foreground">
        {scrape.down ? "Scrape down" : "Scrape stale"}
      </span>
      {scrape.stalenessMs != null && (
        <span>no scrape for {formatStaleness(staleness)}</span>
      )}
      {scrape.lastSuccess && <span className="font-mono">last success {scrape.lastSuccess}</span>}
      <span className="sm:ml-auto">zero values below are filler, not measurements</span>
    </div>
  );
}

// ── Front-end model card ────────────────────────────────────────────────────

// A front-end model's current state. The requests series comes from continuous
// aggregates that lag the raw tables by a minute or two, so on its own it misses
// requests that just completed. The OPTIONAL decode_tps-by-model series is read
// raw and mapped to the model group server-side (deployment_inventory), so its
// points are merged in: whichever of the two saw activity in the window wins.
function frontendState(requestPoints: MetricPoint[], decodeModelPoints: MetricPoint[]) {
  return currentState([...requestPoints, ...decodeModelPoints]);
}

function FrontendCard({
  label,
  query,
  group,
  index,
  range,
  decodeByModel,
  inputByModel,
}: {
  label: string;
  query: UseSeriesResult;
  group: string;
  index: number;
  range: Range;
  decodeByModel: UseSeriesResult;
  inputByModel: UseSeriesResult;
}) {
  const points = pointsFor(query, group);
  // Both throughput stats come from the OPTIONAL group=model series, so they
  // read "—" until the backend serves them.
  const decodeModelPoints = pointsFor(decodeByModel, group);
  const inputModelPoints = pointsFor(inputByModel, group);
  const caption = `requests · ${range}`;

  return (
    <article data-testid="frontend-card" className="surface p-4">
      <CardHeader
        title={label}
        fullLabel={`${label} · requests (${range})`}
        caption={caption}
        swatch={legendColor(index)}
        state={
          query.isLoading || query.isError ? undefined : frontendState(points, decodeModelPoints)
        }
      />
      {query.isLoading ? (
        <Skeleton height={FRONTEND_CHART_PX} />
      ) : query.isError ? (
        <InlineError>Failed to load {label}</InlineError>
      ) : (
        <>
          {/* RPM on the request side is the per-minute request mean, idle/error
              buckets excluded. */}
          <CardStats
            stats={[
              { label: "Avg Decode t/s", value: formatStat(meanOfActive(decodeModelPoints), 1) },
              { label: "Input t/s", value: formatStat(meanOf(inputModelPoints), 1) },
              { label: "RPM", value: formatStat(meanExcludingStates(points), 1) },
            ]}
          />
          <GraphBlock label="Requests">
            <MetricLineChart points={points} seriesIndex={index} height={FRONTEND_CHART_PX} />
          </GraphBlock>
          {/* Front-end decode throughput only renders when group=model decode
              data exists; the dev mock does not serve tps metrics, so in dev this
              graph is legitimately absent. */}
          {decodeModelPoints.length > 0 && (
            <GraphBlock label="Decode token/s">
              <MetricLineChart
                points={decodeModelPoints}
                seriesIndex={(index + 1) % 6}
                height={BACKEND_CHART_PX}
              />
            </GraphBlock>
          )}
        </>
      )}
    </article>
  );
}

// No stats row on provider cards: they are provider-scoped, and decode /
// input-token / requests-per-min do not map to a provider.
function ProviderErrorCard({
  label,
  query,
  group,
  range,
}: {
  label: string;
  query: UseSeriesResult;
  group: string;
  range: Range;
}) {
  const points = pointsFor(query, group);
  return (
    <article data-testid="provider-card" className="surface p-4">
      <CardHeader
        title={label}
        fullLabel={`${label} · errors (${range})`}
        caption={`errors by provider · ${range}`}
        state={query.isLoading || query.isError ? undefined : currentState(points)}
      />
      {query.isLoading ? (
        <Skeleton height={FRONTEND_CHART_PX} />
      ) : query.isError ? (
        <InlineError>Failed to load {label}</InlineError>
      ) : (
        <GraphBlock label="Errors">
          <StateBarChart points={points} height={FRONTEND_CHART_PX} />
        </GraphBlock>
      )}
    </article>
  );
}

// ── Back-end deployment cards ───────────────────────────────────────────────
// One card per deployment: two stacked graphs, each inside its own
// ResponsiveContainer within MetricLineChart, so the two keep independent Y
// scales. Ranking stays decode-driven, but the group list is re-widened
// afterwards so inventory-backed backends are never dropped.

// `label` is the already-ranked (deploymentLabel-composed) group label, split
// for display only into the model_id title and the LiteLLM model name subtitle.
// `seriesIndex` is its rank, so decode colours line up with the ranking and the
// input graph deliberately takes the next swatch so the two graphs on one card
// never share a colour.
function DeploymentCard({
  label,
  group,
  seriesIndex,
  range,
  decode,
  input,
  rpm,
}: {
  label: string;
  group: string;
  seriesIndex: number;
  range: Range;
  decode: UseSeriesResult;
  input: UseSeriesResult;
  rpm: UseSeriesResult;
}) {
  const decodePoints = pointsFor(decode, group);
  const inputPoints = pointsFor(input, group);
  const rpmPoints = pointsFor(rpm, group);
  const sep = label.indexOf(" · ");
  const title = sep === -1 ? label : label.slice(0, sep);
  const subtitle = sep === -1 ? undefined : label.slice(sep + 3);

  return (
    <article data-testid="deployment-card" className="surface p-4">
      <CardHeader
        title={title}
        fullLabel={`${label} (${range})`}
        subtitle={subtitle}
        caption={`deployment · ${range}`}
        swatch={legendColor(seriesIndex)}
        state={decode.isLoading || decode.isError ? undefined : currentState(decodePoints)}
      />

      {/* Three numbers per back-end endpoint, all grouped by model_id: decode_tps,
          input_tps and requests_per_min. Decode t/s is tokens per DECODE second,
          so it averages active buckets only (meanOfActive); input t/s stays a
          wall-clock mean; requests_per_min excludes idle+error buckets via
          meanExcludingStates().
          Each of the three renders 0 — never "—", never a hidden card — when its
          series is missing, empty, or scrape-down filler. */}
      <CardStats
        stats={[
          { label: "Decode t/s", value: statOrZero(meanOfActive(decodePoints), 1) },
          { label: "Input t/s", value: statOrZero(meanOf(inputPoints), 1) },
          { label: "Req/min", value: statOrZero(meanExcludingStates(rpmPoints), 1) },
        ]}
      />

      <GraphBlock label="Decode token/s">
        {decode.isLoading ? (
          <Skeleton height={BACKEND_CHART_PX} />
        ) : decode.isError ? (
          <InlineError>Failed to load decode</InlineError>
        ) : (
          <MetricLineChart points={decodePoints} seriesIndex={seriesIndex} height={BACKEND_CHART_PX} />
        )}
      </GraphBlock>

      <GraphBlock label="Input token/s">
        {input.isLoading ? (
          <Skeleton height={BACKEND_CHART_PX} />
        ) : input.isError ? (
          <InlineError>Failed to load input tps</InlineError>
        ) : inputPoints.length === 0 ? (
          <NoSeriesData note="No input-token data" height={BACKEND_CHART_PX} />
        ) : (
          <MetricLineChart
            points={inputPoints}
            seriesIndex={(seriesIndex + 1) % 6}
            height={BACKEND_CHART_PX}
          />
        )}
      </GraphBlock>
    </article>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

export function FleetMetricsPanel({ range = "1h" }: { range?: Range }) {
  const requestsByModel = useSeries("requests", range, "model");
  const errorsByProvider = useSeries("errors", range, "api_provider");
  const decodeByDeployment = useSeries("decode_tps", range, "model_id");
  // First-class backend graph: the input-token rate per deployment, keyed by
  // model_id exactly like decode, so both graphs land on the same cards.
  // `input_tps` is an input-TOKEN rate — it is NOT true prefill throughput.
  const inputByDeployment = useSeries("input_tps", range, "model_id");

  // Three OPTIONAL series. They deliberately do NOT join the panel-wide loading
  // gate: they only extend the panel (extra stats and an extra graph on cards
  // that already exist) and each degrades silently to "—" / no graph when it
  // errors or comes back empty. Gating on them would let a slow or failed
  // secondary series skeleton the whole dashboard.
  const decodeByModel = useSeries("decode_tps", range, "model");
  const inputByModel = useSeries("input_tps", range, "model");
  // Per-backend served requests per minute, grouped by model_id.
  const rpmByDeployment = useSeries("requests_per_min", range, "model_id");

  // Longest retained window (raw data is kept 7 d): the all-time max source.
  // Optional like the series above — it never gates the panel.
  const decodeAllTime = useSeries("decode_tps", "7d", "model_id");
  // Ghost-proofed: combined sums iterate the rostered, unassigned-filtered set
  // only — ghost data (metric-only groups) must never reach a fleet rate.
  const maxCombinedTps = maxCombinedTokenRate(rosteredVisible(decodeAllTime.data));

  const combinedTps = combinedObservedTokenRate(rosteredVisible(decodeByDeployment.data));

  // True fleet AGGREGATE: Σ output tokens / bucket wall-clock seconds — the
  // concurrency-inclusive frame (TTFT/prefill/queue legitimately count as
  // seconds in which the fleet emitted no tokens). Ghost-proofed like above.
  const aggregateByDeployment = useSeries("aggregate_output_tps", range, "model_id");
  const maxAggregateTps = maxCombinedTokenRate(rosteredVisible(aggregateByDeployment.data));

  // "observed" is deliberate: this is measured throughput summed
  // over deployments, NOT a rated/max figure. Rendered during loading too, where
  // the series has no data yet and the stat correctly reads "—".
  const combinedTile = (
    <SummaryTile
      testId="fleet-combined-tps"
      label="Combined Token/s (observed)"
      value={formatStat(combinedTps, 0)}
      unit="tok/s"
      detail={`sum across deployments · ${range}`}
      info="Sum of each deployment's own average per-stream decode rate — idle and error buckets excluded. Per-stream frame: two concurrent streams add their decode seconds, not wall-clock, so this reads higher than the fleet aggregate. Backends that mix in non-streaming requests are classifier-corrected (estimated TTFT subtracted). Ghost and unassigned groups are excluded."
      accent
    />
  );

  // While ANY GATED series is still pending we have no data to rank -> one
  // skeleton. The three optional series are deliberately absent from this gate.
  if (
    requestsByModel.isLoading ||
    errorsByProvider.isLoading ||
    decodeByDeployment.isLoading ||
    inputByDeployment.isLoading
  ) {
    return (
      <section aria-label="Fleet Metrics">
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
          {combinedTile}
          <Skeleton height={112} className="rounded-xl" />
          <Skeleton height={112} className="rounded-xl" />
          <Skeleton height={112} className="rounded-xl" />
          <Skeleton height={112} className="rounded-xl" />
          <Skeleton height={112} className="rounded-xl" />
        </div>
        <div className={FRONTEND_GRID}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={320} className="rounded-xl" />
          ))}
        </div>
      </section>
    );
  }

  const requestGroups = topOf(requestsByModel);
  const errorGroups = topOf(errorsByProvider);
  // Deployment-side ranking goes through deploymentLabel, so a back-end card
  // label is `model_id · litellm_model_name` (or the bare model_id, or
  // UNKNOWN_DEPLOYMENT) and can never read "unlabeled". Ranking is decode-driven
  // (see the back-end card note above), then re-widened so inventory-backed
  // backends are never dropped by the top-N cut, and — only while the debug flag is
  // on — the always-emitted "unassigned" group gets its card pinned at the end.
  const deploymentPoints = visibleSeries(decodeByDeployment.data);
  const deploymentGroups = withUnassigned(
    withInventory(
      topOf(decodeByDeployment, deploymentLabel),
      deploymentPoints,
      deploymentLabel,
    ),
    deploymentPoints,
  );

  const requestsTitle = `requests by model (${range})`;
  const errorsTitle = `errors by provider (${range})`;

  // Empty only when every GATING series resolved without error and produced no
  // groups. The input-token rate is a secondary graph on the same cards, so it must
  // not gate emptiness (neither do the optional per-model / per-deployment series).
  const everythingEmpty =
    !requestsByModel.isError &&
    requestGroups.length === 0 &&
    !errorsByProvider.isError &&
    errorGroups.length === 0 &&
    deploymentGroups.length === 0 &&
    !decodeByDeployment.isError;

  const deploymentStates = deploymentGroups.map((g) => currentState(pointsFor(decodeByDeployment, g.group)));
  const modelStates = requestGroups.map((g) =>
    frontendState(pointsFor(requestsByModel, g.group), pointsFor(decodeByModel, g.group)),
  );
  const streamingModels = modelStates.filter((s) => s === "healthy" || s === "prefill").length;
  const peak = peakOf(deploymentPoints);
  const peakLabel = peak
    ? deploymentGroups.find((g) => g.group === peak.group)?.label.split(" · ")[0] ?? peak.group
    : null;

  return (
    <section aria-labelledby="fleet-metrics-heading">
      <h2 id="fleet-metrics-heading" className="sr-only">Fleet Metrics</h2>
      <ScrapeBanner />

      <div data-testid="fleet-summary" className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {combinedTile}
        <SummaryTile
          label={`Peak decode · ${range}`}
          value={peak ? formatStat(peak.value, 1) : "—"}
          unit={peak ? "tok/s" : undefined}
          detail={peakLabel ? `highest single bucket · ${peakLabel}` : "no decode buckets in window"}
        />
        <SummaryTile
          label="Back-end deployments"
          value={deploymentGroups.length}
          detail="activity in the last 3 min"
        >
          <StateMix states={deploymentStates} />
        </SummaryTile>
        <SummaryTile
          label="Front-end models"
          value={requestGroups.length}
          detail={`${streamingModels} served traffic in the last 3 min`}
        >
          <StateMix states={modelStates} />
        </SummaryTile>
        <SummaryTile
          testId="fleet-max-combined-tps"
          label="Max Combined Token/s (ever)"
          value={formatStat(maxCombinedTps, 0)}
          unit={maxCombinedTps === null ? undefined : "tok/s"}
          detail="best fleet-wide bucket · last 7d"
          info="The highest single time bucket of the last 7 days: every deployment's per-stream decode rate summed per bucket, then the best bucket taken. Same frame as Combined (observed), so treat it as a best-case statistic, not a sustained rate. Ghost and unassigned groups are excluded."
        />
        <SummaryTile
          testId="fleet-aggregate-tps"
          label="Fleet Aggregate Token/s"
          value={formatStat(maxAggregateTps, 0)}
          unit={maxAggregateTps === null ? undefined : "tok/s"}
          detail={`wall-clock · ${range}`}
          info="The honest fleet-wide rate: all output tokens divided by wall-clock seconds, so concurrent backends add up and every second counts exactly once. Prefill, queue and idle time show up here as seconds in which the fleet emitted no tokens — the counterpart to the per-stream frames above, where TTFT is subtracted instead. Ghost and unassigned groups are excluded."
        />
      </div>

      {/* Front-end Models — the request side of the fleet: requests by model
          (area charts) and errors by provider (state bars). */}
      <section data-testid="frontend-section" className="mb-12">
        <SectionHeader
          title="Front-end Models"
          count={requestGroups.length}
          description="Request side · what clients call through the LiteLLM proxy"
          aside={
            <div className="flex flex-col items-end gap-2">
              {/* The legend scale has exactly six distinct colours, so it stays
                  capped at LEGEND_MAX entries even though up to PANEL_TOP_N cards
                  are rendered. */}
              <Legend groups={requestGroups.slice(0, LEGEND_MAX)} />
              <StateLegend />
            </div>
          }
        />

        <div data-testid="frontend-grid" className={FRONTEND_GRID}>
          {requestsByModel.isError ? (
            <SeriesErrorCard title={requestsTitle} />
          ) : (
            requestGroups.map((g, i) => (
              <FrontendCard
                key={`req:${g.group}`}
                label={g.label}
                query={requestsByModel}
                group={g.group}
                index={i}
                range={range}
                decodeByModel={decodeByModel}
                inputByModel={inputByModel}
              />
            ))
          )}

          {errorsByProvider.isError ? (
            <SeriesErrorCard title={errorsTitle} />
          ) : (
            errorGroups.map((g) => (
              <ProviderErrorCard
                key={`err:${g.group}`}
                label={g.label}
                query={errorsByProvider}
                group={g.group}
                range={range}
              />
            ))
          )}
        </div>
      </section>

      {/* Back-end Deployments — the deployment side of the fleet: ONE card per
          top deployment group, carrying both throughput graphs and the stats. */}
      <section data-testid="backend-section">
        <SectionHeader
          title="Back-end Deployments"
          count={deploymentGroups.length}
          description="Deployment side · one row per model family, sorted by name"
        />

        {decodeByDeployment.isError ? (
          <div data-testid="backend-grid" className={BACKEND_GRID}>
            {/* The ranking series itself failed: nothing to chart, so report it
                once for the whole series instead of per-group. */}
            <SeriesErrorCard title={`decode tps by deployment (${range})`} />
          </div>
        ) : (
          // One row per family (model_id prefix), families and cards sorted by
          // name. Colours follow the sorted order so they read left-to-right.
          <div className="flex flex-col gap-6">
            {(() => {
              let colour = 0;
              return groupByFamily(deploymentGroups).map((fam) => (
                <div key={fam.family} data-testid="backend-family">
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="eyebrow">{fam.family || "unknown"}</h3>
                    <span className="text-[11px] tabular-nums text-muted-foreground/70">
                      {fam.groups.length}
                    </span>
                    <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
                  </div>
                  <div data-testid="backend-grid" className={BACKEND_GRID}>
                    {fam.groups.map((g) => (
                      <DeploymentCard
                        key={`decode_tps:${g.group}`}
                        label={g.label}
                        group={g.group}
                        seriesIndex={colour++}
                        range={range}
                        decode={decodeByDeployment}
                        input={inputByDeployment}
                        rpm={rpmByDeployment}
                      />
                    ))}
                  </div>
                </div>
              ));
            })()}
          </div>
        )}
      </section>

      {/* Empty state only when ALL gating, resolved (non-error) series are empty. */}
      {everythingEmpty && (
        <div
          data-testid="fleet-empty"
          className="surface flex flex-col items-center gap-1 p-10 text-center"
        >
          <div className="text-sm font-medium text-foreground">No data</div>
        </div>
      )}
    </section>
  );
}
