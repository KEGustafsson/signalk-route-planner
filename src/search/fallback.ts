import type { LonLat } from "../foundation/geo";
import type { Verdict } from "../oracle/contract";
import type { Shortcut } from "./pull";
import type { QuadNode, QuadTree } from "./quadtree";

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
  if (
    (n.state !== "blocked" && n.state !== "unverified" && n.state !== "marginal") ||
    !v ||
    !crossable(v)
  ) {
    return Infinity;
  }
  return 1 + RISK_WEIGHT * v.risk + (v.status === "unverified" ? UNVERIFIED_WEIGHT : 0);
}

/**
 * Per-metre cost of a leaf in the strict search: free water 1; a smallest square the check
 * marks marginal, which a strict plan accepts, at the same risk cost as the fallback, so the
 * route crosses as little of it as it can; Infinity elsewhere.
 */
export function strictWeight(n: QuadNode): number {
  if (n.state === "free") {
    return 1;
  }
  return n.state === "marginal" && n.verdict ? 1 + RISK_WEIGHT * n.verdict.risk : Infinity;
}

/**
 * A shortcut that does not pass may replace path points i..j only when every piece of
 * the path between them already crosses a square the check does not pass, `allowed`
 * takes the shortcut's verdict (the fallback: no land or uncharted water; the strict
 * search: marginal), and it is no riskier than the riskiest of those squares: pulling
 * straightens a risky stretch within itself and never draws passing water into it.
 */
export function riskyShortcut(
  tree: QuadTree,
  path: readonly LonLat[],
  allowed: (v: Verdict) => boolean
): Shortcut {
  const risk = path.slice(1).map((b, k) => {
    const a = path[k] as LonLat;
    const [ax, ay] = tree.units(a);
    const [bx, by] = tree.units(b);
    const leaf = tree.leafAt((ax + bx) / 2, (ay + by) / 2);
    // A free square's piece is not risky, whatever its verdict's own risk.
    return leaf?.state === "free" ? undefined : (leaf?.verdict?.risk ?? 0);
  });
  return (v, i, j) => {
    const span = risk.slice(i, j);
    return (
      crossable(v) &&
      allowed(v) &&
      span.every((r) => r !== undefined) &&
      v.risk <= Math.max(...(span as number[]))
    );
  };
}
