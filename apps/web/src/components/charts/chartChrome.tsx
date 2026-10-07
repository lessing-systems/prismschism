// Shared visual chrome for the Recharts components: themed axis/grid props, the
// tooltip card, the per-bucket state ribbon and the date row. Pure presentation
// — no data shaping beyond what each piece displays.
import type { MetricPoint } from "@/lib/types";
import { isErrorSentinel } from "@/lib/types";
import { stateToken } from "./stateTokens";
import { formatTick } from "./axisFormat";
import { STATE_LABEL } from "@/components/StateIndicator";

/** Y axis width in px; the state ribbon is inset by the same amount so it lines up with the plot. */
export const Y_AXIS_WIDTH = 50;
export const CHART_MARGIN = { top: 8, right: 4, bottom: 0, left: 0 } as const;

const TICK = { fontSize: 10, fill: "hsl(var(--muted-foreground))", fillOpacity: 0.8 };

export const gridProps = {
  stroke: "hsl(var(--border))",
  strokeOpacity: 0.7,
  strokeDasharray: "2 4",
  vertical: false,
} as const;

export const xAxisProps = {
  dataKey: "t",
  tickFormatter: formatTick,
  tick: TICK,
  tickLine: false,
  axisLine: { stroke: "hsl(var(--border))" },
  minTickGap: 28,
  tickMargin: 6,
  height: 22,
} as const;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Y tick label: compact notation so 2,000,000 reads "2M" and never clips. */
export function formatYTick(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? compact.format(value) : String(value);
}

export function yAxisProps(unit: string | undefined) {
  return {
    tick: TICK,
    tickFormatter: formatYTick,
    tickLine: false,
    axisLine: false,
    width: Y_AXIS_WIDTH,
    allowDecimals: false,
    label: unit
      ? {
          value: unit,
          angle: -90,
          position: "insideLeft" as const,
          offset: 2,
          style: { fontSize: 10, textAnchor: "middle" as const, fill: "hsl(var(--muted-foreground))", fillOpacity: 0.7 },
        }
      : undefined,
  };
}

interface TooltipEntry {
  value?: unknown;
  payload?: MetricPoint;
}

/** Tooltip card: time, value (+unit) and the bucket's traffic-light state. */
export function ChartTooltip({
  active,
  payload,
  label,
  accent,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: unknown;
  accent?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const raw = payload[0].value;
  const sentinel = typeof raw === "number" && isErrorSentinel(raw) && point?.state === "error";
  const value =
    typeof raw === "number"
      ? sentinel
        ? "error"
        : raw.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : typeof raw === "string"
        ? raw
        : "—";
  return (
    <div className="min-w-[132px] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl shadow-black/30">
      <div className="mb-1 font-mono text-[10px] text-muted-foreground">{formatTick(label)} UTC</div>
      <div className="flex items-baseline gap-1.5">
        {accent && (
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: accent }} />
        )}
        <span className="text-sm font-semibold tabular-nums">{value}</span>
        {point?.unit && !sentinel && <span className="text-muted-foreground">{point.unit}</span>}
      </div>
      {point?.state && (
        <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: stateToken(point.state) }}
          />
          {STATE_LABEL[point.state]}
          {point.synthetic && <span className="text-foreground/70">· scrape filler</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The per-bucket traffic-light state as a thin ribbon under the plot, so state
 * over time reads without a dot on every point. Consecutive buckets in the same
 * state merge into one segment; null-valued buckets (gaps) stay transparent.
 * Inset by the Y axis width so it sits under the plot area.
 */
export function StateStrip({ points }: { points: MetricPoint[] }) {
  if (points.length === 0) return null;
  const runs: { key: string; color: string; idle: boolean; n: number }[] = [];
  for (const p of points) {
    const key = p.value == null ? "gap" : (p.state ?? "none");
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.n += 1;
    else
      runs.push({
        key,
        color: key === "gap" ? "transparent" : stateToken(p.state),
        idle: p.state === "idle",
        n: 1,
      });
  }
  return (
    <div
      data-testid="state-strip"
      aria-hidden="true"
      className="mt-1 flex h-[3px] gap-[2px]"
      style={{ marginLeft: Y_AXIS_WIDTH + CHART_MARGIN.left, marginRight: CHART_MARGIN.right }}
    >
      {runs.map((r, i) => (
        <span
          key={i}
          className="h-full rounded-full"
          style={{ flexGrow: r.n, flexBasis: 0, backgroundColor: r.color, opacity: r.idle ? 0.4 : 1 }}
        />
      ))}
    </div>
  );
}

/** The sliding DD/MM date row under the X axis (see axisFormat.computeDateLabels). */
export function DateRow({ labels }: { labels: { left: string | null; right: string } | null }) {
  if (!labels) return null;
  return (
    <div
      data-testid="chart-date-labels"
      className="flex justify-between pt-1 font-mono text-[10px] leading-none text-muted-foreground/70"
      style={{ paddingLeft: Y_AXIS_WIDTH }}
    >
      <span>{labels.left ?? ""}</span>
      <span>{labels.right}</span>
    </div>
  );
}
