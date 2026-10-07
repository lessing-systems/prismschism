// Single-series bar chart for one MetricPoint series (t on X, value on Y).
// Each bar is filled by its per-point state via stateToken. Error-window points
// carry value = ERROR_SENTINEL (non-null) so their bar still renders, painted
// blue via the --error token. Null-valued points (down-model gaps) render no bar.
import { isErrorSentinel, type MetricPoint } from "@/lib/types";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { stateToken } from "./stateTokens";
import { computeDateLabels, seriesUnit } from "./axisFormat";
import { CHART_MARGIN, ChartTooltip, DateRow, gridProps, xAxisProps, yAxisProps } from "./chartChrome";

export interface StateBarChartProps {
  points: MetricPoint[];
  height?: number;
}

export function StateBarChart({ points, height = 168 }: StateBarChartProps) {
  const labels = computeDateLabels(points);
  const unit = seriesUnit(points);
  return (
    <div data-testid="state-bar-chart">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={points} margin={CHART_MARGIN} barCategoryGap="18%">
          <CartesianGrid {...gridProps} />
          <XAxis {...xAxisProps} />
          <YAxis {...yAxisProps(unit)} />
          <Tooltip
            cursor={{ fill: "hsl(var(--foreground))", fillOpacity: 0.04 }}
            content={<ChartTooltip />}
          />
          {/* Default YAxis domain [0, 'auto'] keeps the ERROR_SENTINEL (25) bar a
              small but visible sliver next to ~1e2–1e4 request buckets — no domain
              override needed. */}
          <Bar dataKey="value" isAnimationActive={false} radius={[2, 2, 0, 0]} maxBarSize={14}>
            {points.map((p, i) => (
              <Cell
                key={i}
                fill={
                  isErrorSentinel(p.value) || p.state === "error"
                    ? stateToken("error")
                    : stateToken(p.state)
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <DateRow labels={labels} />
    </div>
  );
}
