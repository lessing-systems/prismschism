// Groups back-end deployment cards into families for display, one row each.
//
// The family is the model_id prefix before the first "-" ("tools-qwen38-q3" ->
// "tools", "vision-qwen38-q3" -> "vision"). This is a naming-convention
// heuristic: the authoritative mapping is deployment_inventory.model_group, which
// the API does not yet expose on series points. A model_id without a "-" is its
// own family.
//
// Families sort alphabetically; cards within a family sort by model_id. A
// missing model_id ("" — a data defect, labelled unknown-deployment) goes after
// every named family, and the debug-only "unassigned" group always goes last.
// Pure, display-only — ranking (which groups appear at all) stays in
// selectTopGroups/withInventory.
import type { TopGroup } from "@/lib/topGroups";
import { UNASSIGNED_GROUP } from "@/lib/debug";

export interface DeploymentFamily {
  family: string;
  groups: TopGroup[];
}

export function deploymentFamily(group: string): string {
  const i = group.indexOf("-");
  return i > 0 ? group.slice(0, i) : group;
}

const byCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function groupByFamily(groups: TopGroup[]): DeploymentFamily[] {
  const map = new Map<string, TopGroup[]>();
  for (const g of groups) {
    const family = g.group === UNASSIGNED_GROUP ? UNASSIGNED_GROUP : deploymentFamily(g.group);
    const bucket = map.get(family);
    if (bucket) bucket.push(g);
    else map.set(family, [g]);
  }
  const families = [...map.entries()].map(([family, gs]) => ({
    family,
    groups: [...gs].sort((a, b) => byCodepoint(a.group, b.group)),
  }));
  const tail = (f: string) => (f === UNASSIGNED_GROUP ? 2 : f === "" ? 1 : 0);
  families.sort((a, b) => tail(a.family) - tail(b.family) || byCodepoint(a.family, b.family));
  return families;
}
