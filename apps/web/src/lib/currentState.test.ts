import { describe, expect, it } from "vitest";
import { CURRENT_WINDOW_MS, currentState } from "./currentState";
import type { MetricPoint, MetricPointState } from "./types";

const NOW = Date.parse("2026-10-04T21:07:30.000Z");
const at = (hhmm: string, state?: MetricPointState, group = "g"): MetricPoint => ({
  t: `2026-10-04T${hhmm}:00.000Z`,
  group,
  value: 0,
  state,
});

describe("currentState", () => {
  it("keeps a backend 'healthy' when a request completed a minute ago but the live bucket is idle", () => {
    const pts = [at("21:04", "healthy"), at("21:05", "idle"), at("21:06", "idle"), at("21:07", "idle")];
    expect(currentState(pts, NOW)).toBe("healthy");
  });

  it("judges a lagging series against the same wall clock (front-end cagg ends earlier)", () => {
    const pts = [at("21:03", "idle"), at("21:04", "healthy"), at("21:05", "idle")];
    expect(currentState(pts, NOW)).toBe("healthy");
  });

  it("reads idle once activity is older than the window", () => {
    const pts = [at("20:58", "healthy"), at("21:05", "idle"), at("21:06", "idle"), at("21:07", "idle")];
    expect(currentState(pts, NOW)).toBe("idle");
  });

  it("ranks error over healthy over prefill over idle inside the window", () => {
    expect(currentState([at("21:06", "prefill"), at("21:07", "idle")], NOW)).toBe("prefill");
    expect(currentState([at("21:06", "prefill"), at("21:06", "healthy")], NOW)).toBe("healthy");
    expect(currentState([at("21:05", "error"), at("21:06", "healthy")], NOW)).toBe("error");
  });

  it("falls back to the last stated point when nothing is inside the window", () => {
    const pts = [at("20:00", "idle"), at("20:10", "prefill")];
    expect(currentState(pts, NOW)).toBe("prefill");
  });

  it("widens the window by one bucket so a coarse bucket that started earlier still counts", () => {
    // 5m buckets: 21:00 holds activity up to 21:05, i.e. inside 3 min of 21:07:30.
    const pts = [at("20:55", "idle"), at("21:00", "healthy"), at("21:05", "idle")];
    expect(currentState(pts, NOW)).toBe("healthy");
    expect(CURRENT_WINDOW_MS).toBe(180_000);
  });

  it("is undefined when no point carries a state", () => {
    expect(currentState([at("21:07")], NOW)).toBeUndefined();
    expect(currentState([], NOW)).toBeUndefined();
  });
});
