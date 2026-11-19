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

export function passes(v: Verdict, rule: PassRule): boolean {
  if (v.status === "ok") {
    return true;
  }
  return (
    v.status === "unverified" &&
    rule.accept.length > 0 &&
    v.flags.length > 0 &&
    v.flags.every((f) => rule.accept.includes(f)) &&
    v.risk < rule.probability
  );
}
