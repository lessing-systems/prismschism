// Unit tests for the pure chart axis-label helpers. All fixtures are UTC ISO
// strings, exactly as emitted by the API (e.g. "2026-09-30T09:55:00.000Z").

import { describe, expect, it } from "vitest";

import {
  computeDateLabels,
  formatDateLabel,
  formatTick,
  seriesUnit,
} from "./axisFormat";

describe("formatTick — X ticks carry HH:mm only", () => {
  it("slices HH:mm out of a UTC ISO timestamp (no MM-DD, no space)", () => {
    expect(formatTick("2026-09-30T23:45:00.000Z")).toBe("23:45");
  });

  it("keeps leading zeros in the hour and minute", () => {
    expect(formatTick("2026-09-30T00:05:00.000Z")).toBe("00:05");
  });

  it("stringifies non-string values", () => {
    expect(formatTick(42)).toBe("42");
  });

  it("passes through strings too short to be timestamps", () => {
    expect(formatTick("abc")).toBe("abc");
  });
});

describe("formatDateLabel — European DD/MM", () => {
  it("renders day before month", () => {
    expect(formatDateLabel("2026-09-30T23:45:00.000Z")).toBe("30/09");
  });

  it("keeps leading zeros on day and month", () => {
    expect(formatDateLabel("2026-01-01T00:00:00.000Z")).toBe("01/01");
  });

  it("passes non-string values through as strings", () => {
    expect(formatDateLabel(2026)).toBe("2026");
  });

  it("passes short strings through untouched", () => {
    expect(formatDateLabel("t1")).toBe("t1");
  });
});

describe("computeDateLabels — sliding two-date midnight rule", () => {
  it("window entirely BEFORE midnight", () => {
    expect(
      computeDateLabels([
        { t: "2026-09-30T23:10:00.000Z" },
        { t: "2026-09-30T23:45:00.000Z" },
      ])
    ).toEqual({ left: null, right: "30/09" });
  });

  it("window STRADDLING midnight", () => {
    expect(
      computeDateLabels([
        { t: "2026-09-30T23:45:00.000Z" },
        { t: "2026-10-01T00:10:00.000Z" },
      ])
    ).toEqual({ left: "30/09", right: "01/10" });
  });

  it("window entirely AFTER midnight (slid fully past the older date)", () => {
    expect(
      computeDateLabels([
        { t: "2026-10-01T00:05:00.000Z" },
        { t: "2026-10-01T00:40:00.000Z" },
      ])
    ).toEqual({ left: null, right: "01/10" });
  });

  it("empty window renders no date row at all", () => {
    expect(computeDateLabels([])).toBeNull();
  });

  it("single point shows only that date, on the right", () => {
    expect(computeDateLabels([{ t: "2026-09-30T09:55:00.000Z" }])).toEqual({
      left: null,
      right: "30/09",
    });
  });

  it("7d window spanning many midnights shows first-date left / last-date right only", () => {
    expect(
      computeDateLabels([
        { t: "2026-09-24T00:00:00.000Z" },
        { t: "2026-09-25T12:00:00.000Z" },
        { t: "2026-09-26T12:00:00.000Z" },
        { t: "2026-09-27T12:00:00.000Z" },
        { t: "2026-09-28T12:00:00.000Z" },
        { t: "2026-09-29T12:00:00.000Z" },
        { t: "2026-09-30T12:00:00.000Z" },
      ])
    ).toEqual({ left: "24/09", right: "30/09" });
  });

  it("unsorted input is normalised to the same result as sorted input", () => {
    const sorted = [
      { t: "2026-09-30T23:45:00.000Z" },
      { t: "2026-10-01T00:10:00.000Z" },
    ];
    const unsorted = [sorted[1], sorted[0]];
    expect(computeDateLabels(unsorted)).toEqual(computeDateLabels(sorted));
    expect(computeDateLabels(unsorted)).toEqual({ left: "30/09", right: "01/10" });
  });
});

describe("seriesUnit — first defined non-empty unit wins", () => {
  it("returns the unit carried by the points", () => {
    expect(seriesUnit([{ unit: "token/s" }, { unit: "token/s" }])).toBe("token/s");
  });

  it("skips earlier points without a unit and takes the first defined one", () => {
    expect(seriesUnit([{}, { unit: "requests" }])).toBe("requests");
  });

  it("is undefined when no point carries a unit", () => {
    expect(seriesUnit([{}])).toBeUndefined();
  });

  it("treats an empty string as no unit (never renders an empty label)", () => {
    expect(seriesUnit([{ unit: "" }])).toBeUndefined();
  });

  it("is undefined for an empty series", () => {
    expect(seriesUnit([])).toBeUndefined();
  });
});
