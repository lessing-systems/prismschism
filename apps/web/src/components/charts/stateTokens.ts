// Maps a MetricPoint's 5-state traffic-light value to the matching CSS color
// token. Consumed by the chart components (MetricLineChart / StateBarChart) so
// marks are painted with theme-aware `hsl(var(--token))` colors instead of hex
// literals.
import type { MetricPointState } from "@/lib/types";

// Re-exported for chart convenience (error-window points carry value = sentinel).
export { ERROR_SENTINEL } from "@/lib/types";

export function stateToken(state?: MetricPointState): string {
  switch (state) {
    case "idle":
      return "hsl(var(--idle))";
    case "error":
      return "hsl(var(--error))";
    case "healthy":
      return "hsl(var(--healthy))";
    case "prefill":
      return "hsl(var(--prefill))";
    default:
      // Undefined = an UNCLASSIFIED series (e.g. a provider aggregate, which the
      // mock emits with no per-point state). Map it to the neutral default series
      // color --chart-1. We deliberately do NOT use --disabled here: --disabled is
      // traffic-light semantics for an offline deployment and would wrongly read as
      // "this series is disabled UI" when the point is simply unannotated.
      return "hsl(var(--chart-1))";
  }
}
