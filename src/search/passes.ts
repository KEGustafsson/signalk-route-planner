import type { Verdict } from "../oracle/contract";

/**
 * Which verdicts the search may plan through (plan §4.1). `ok` always. With
 * `accept` set, also an `unverified` verdict whose every flag is listed there
 * and whose risk is below `probability`: water the chart scores as passable but
 * the route check cannot verify for a listed reason, such as data marked not for
 * navigation. The route check still decides each leg's status, so a route
 * through such water comes back `unverified`, never `ok` (AGENTS.md invariant 2).
 */
export interface PassRule {
  accept: readonly string[];
  probability: number;
}

/** Flags a request may accept: the source is not for navigation, the water is charted. */
export const ACCEPTABLE_FLAGS = ["NOT_FOR_NAVIGATION"] as const;

export const OK_ONLY: PassRule = { accept: [], probability: 0 };

/**
 * Flags that describe the water and never leave a verdict unverified: an `ok` verdict carries
 * them too. An `unverified` one passes on its other flags alone (signalk-underkeel's swept or
 * dredged fairway in a cell not for navigation reads `DREDGED`, `NOT_FOR_NAVIGATION`).
 */
const DESCRIBES = new Set([
  "SWEPT",
  "DREDGED",
  "LIVECHART_ADJUSTED",
  "FAIRWAY_GAP",
  "TRAFFIC_LANE",
  "CLEARANCE_RISE_ASSUMED",
  "ENTRY_RESTRICTED",
  "AREA_TO_BE_AVOIDED"
]);

export function passes(v: Verdict, rule: PassRule): boolean {
  if (v.status === "ok") {
    return true;
  }
  const causes = v.flags.filter((f) => !DESCRIBES.has(f));
  return (
    v.status === "unverified" &&
    rule.accept.length > 0 &&
    causes.length > 0 &&
    causes.every((f) => rule.accept.includes(f)) &&
    v.risk < rule.probability
  );
}
