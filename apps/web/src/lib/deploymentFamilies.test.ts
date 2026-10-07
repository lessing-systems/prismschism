import { describe, expect, it } from "vitest";
import { deploymentFamily, groupByFamily } from "./deploymentFamilies";
import type { TopGroup } from "./topGroups";

const g = (group: string, total = 0): TopGroup => ({ group, label: group, total });

describe("deploymentFamily", () => {
  it("takes the model_id prefix before the first dash", () => {
    expect(deploymentFamily("tools-qwen38-q3-main")).toBe("tools");
    expect(deploymentFamily("vision-qwen38-q3")).toBe("vision");
  });

  it("treats a dashless or leading-dash id as its own family", () => {
    expect(deploymentFamily("orchestration")).toBe("orchestration");
    expect(deploymentFamily("-odd")).toBe("-odd");
  });
});

describe("groupByFamily", () => {
  it("sorts families by name and cards by model_id, ignoring rank order", () => {
    const out = groupByFamily([
      g("tools-qwen38-q3-main", 90),
      g("orchestration-qwen38", 80),
      g("tools-qwen38-q3", 70),
      g("vision-qwen38-q3", 60),
      g("tools-qwen38", 0),
    ]);
    expect(out.map((f) => f.family)).toEqual(["orchestration", "tools", "vision"]);
    expect(out[1].groups.map((x) => x.group)).toEqual([
      "tools-qwen38",
      "tools-qwen38-q3",
      "tools-qwen38-q3-main",
    ]);
  });

  it("puts a missing model_id after named families and debug unassigned last", () => {
    const out = groupByFamily([g("unassigned"), g(""), g("alpha-1"), g("zeta-1")]);
    expect(out.map((f) => f.family)).toEqual(["alpha", "zeta", "", "unassigned"]);
  });
});
