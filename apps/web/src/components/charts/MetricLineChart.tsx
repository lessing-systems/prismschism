// Single-series time chart for one MetricPoint series (t on X, value on Y),
// drawn as a stroked area with a soft gradient fill. Gaps (value === null) are
// left open (connectNulls=false) — never bridged.
//
// Per-bucket traffic-light state is shown by the StateStrip ribbon under the
// plot rather than a dot on every point (60+ state-colored dots per chart read
// as noise, and an idle hour became a solid red bar). Dots are kept only for
// FLAGGED points — state "error" or synthetic scrape-down filler — so the blue
// --error light stays unmistakable right on the line: a 0 there is filler, not
// a measurement.
import { useId } from "react";
import type { MetricPoint } from "@/lib/types";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { stateToken } from "./stateTokens";
import { computeDateLabels, seriesUnit } from "./axisFormat";
import {
  CHART_MARGIN,
  ChartTooltip,
  DateRow,
  StateStrip,
  gridProps,
  xAxisProps,
  yAxisProps,
} from "./chartChrome";

export interface MetricLineChartProps {
  points: MetricPoint[];
  height?: number;
  /** Position of this series within its panel group. When supplied, the
   *  stroke cycles the six --legend-N categorical tokens (index ->
   *  --legend-(i % 6 + 1)) so it matches its legend swatch. When omitted the
   *  stroke stays on the frozen --chart-1 default. */
  seriesIndex?: number;
}

interface DotProps {
  cx?: number;
  cy?: number;
  payload?: MetricPoint;
}

function isFlagged(p: MetricPoint): boolean {
  return p.state === "error" || p.synthetic === true;
}

// Returning null is valid in recharts 3 and draws nothing.
function renderDot(props: DotProps): JSX.Element | null {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || payload == null || payload.value == null) return null;
  if (!isFlagged(payload)) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={2.75}
      fill={stateToken(payload.state)}
      stroke="hsl(var(--card))"
      strokeWidth={1}
    />
  );
}

export function MetricLineChart({ points, height = 168, seriesIndex }: MetricLineChartProps) {
  const gradientId = `area-${useId().replace(/:/g, "")}`;
  const labels = computeDateLabels(points);
  const unit = seriesUnit(points);
  const stroke =
    seriesIndex == null ? "hsl(var(--chart-1))" : `hsl(var(--legend-${(seriesIndex % 6) + 1}))`;
  return (
    <div data-testid="metric-chart">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={points} margin={CHART_MARGIN}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.32} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid {...gridProps} />
          <XAxis {...xAxisProps} />
          <YAxis {...yAxisProps(unit)} />
          <Tooltip
            cursor={{ stroke: "hsl(var(--muted-foreground))", strokeOpacity: 0.4, strokeDasharray: "3 3" }}
            content={<ChartTooltip accent={stroke} />}
          />
          <Area
            type="monotone"
            dataKey="value"
            connectNulls={false}
            isAnimationActive={false}
            stroke={stroke}
            strokeWidth={1.75}
            fill={`url(#${gradientId})`}
            dot={renderDot}
            activeDot={{ r: 3.5, fill: stroke, stroke: "hsl(var(--card))", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      <StateStrip points={points} />
      <DateRow labels={labels} />
    </div>
  );
}
