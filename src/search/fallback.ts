import type { Verdict } from "../oracle/contract";
import type { QuadNode } from "./quadtree";

/**
 * The fallback search (plan §4.1 step 8): when no route passes, the least risky
 * route through charted water. A square the check fails or cannot verify may be
 * crossed, at a cost per metre that grows with its P(UKC < 0), so the route crosses
 * as little of it as the chart allows; land and water with no chart at all are
 * never crossed. The route check still decides every leg's status, so the legs over
 * such water come back `fail`, `marginal` or `unverified`, marked as they are.
 */

/** Per-metre cost of crossing a square at P(UKC < 0) = 1. */
export const RISK_WEIGHT = 1000;
/** Per-metre cost of crossing a square the check cannot verify, on top of its risk. */
export const UNVERIFIED_WEIGHT = 100;

/** Flags that close water to the fallback too: land, and no chart at all. */
const CLOSED = ["LAND", "NO_COVERAGE"];

/** True when the fallback may cross water with this verdict. */
export function crossable(v: Pick<Verdict, "flags">): boolean {
  return !v.flags.some((f) => CLOSED.includes(f));
}

/** Per-metre cost of a leaf in the fallback search; Infinity where it may not go. */
export function fallbackWeight(n: QuadNode): number {
  if (n.state === "free") {
    return 1;
  }
  const v = n.verdict;
  if ((n.state !== "blocked" && n.state !== "unverified") || !v || !crossable(v)) {
    return Infinity;
  }
  return 1 + RISK_WEIGHT * v.risk + (v.status === "unverified" ? UNVERIFIED_WEIGHT : 0);
}
