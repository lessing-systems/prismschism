// Traffic-light primitives shared by the shell and the fleet cards.
//
// StateDot    — a single colored dot; "healthy" (streaming) gets a soft ping so
//               live traffic reads at a glance across a wall of cards.
// StateBadge  — dot + label pill for a card header (the group's latest state).
// StateLegend — compact inline key for all five states.
//
// Colors always come from the theme tokens (stateToken / --disabled), never
// literals, so all five schemes stay in lockstep.
import { cn } from "@/lib/utils";
import { stateToken } from "@/components/charts/stateTokens";
import type { TrafficLightState } from "@/lib/types";

export const STATE_LABEL: Record<TrafficLightState, string> = {
  healthy: "Streaming",
  prefill: "Prefill",
  error: "Error",
  idle: "Idle",
  disabled: "Disabled",
};

const STATE_HINT: Record<TrafficLightState, string> = {
  healthy: "healthy — output completed in the last few minutes",
  prefill: "prefill — prefilling (approx)",
  error: "error — request failed / upstream error / scrape down",
  idle: "idle — healthy but quiet",
  disabled: "disabled — metric disabled",
};

export function stateColor(state: TrafficLightState | undefined): string {
  // MetricPointState excludes "disabled"; stateToken() cannot resolve it.
  if (state === "disabled") return "hsl(var(--disabled))";
  return stateToken(state);
}

export function StateDot({
  state,
  size = "md",
  className,
}: {
  state: TrafficLightState | undefined;
  size?: "sm" | "md";
  className?: string;
}) {
  const color = stateColor(state);
  const dim = size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";
  return (
    <span aria-hidden="true" className={cn("relative inline-flex shrink-0", dim, className)}>
      {state === "healthy" && (
        <span
          className="animate-state-ping absolute inset-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className="relative inline-block h-full w-full rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 0 3px ${color.replace(/\)$/, " / 0.18)")}` }}
      />
    </span>
  );
}

export function StateBadge({ state }: { state: TrafficLightState | undefined }) {
  const label = state ? STATE_LABEL[state] : "No state";
  return (
    <span
      role="img"
      aria-label={state ? `Traffic light: ${STATE_HINT[state]}` : "Traffic light: no state reported"}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/60 py-0.5 pl-2 pr-2.5 text-[11px] font-medium text-foreground/90"
    >
      <StateDot state={state} size="sm" />
      {label}
    </span>
  );
}

const LEGEND_ORDER: TrafficLightState[] = ["healthy", "prefill", "error", "idle", "disabled"];

export function StateLegend({ className }: { className?: string }) {
  return (
    <ul
      role="list"
      aria-label="Traffic-light states"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground", className)}
    >
      {LEGEND_ORDER.map((s) => (
        <li key={s} className="flex items-center gap-1.5" title={STATE_HINT[s]}>
          <span
            role="img"
            aria-label={`Traffic light: ${STATE_HINT[s]}`}
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: stateColor(s) }}
          />
          {STATE_LABEL[s]}
        </li>
      ))}
    </ul>
  );
}
