import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { Verdict } from "../oracle/contract";
import type { PassRule } from "./passes";
import { DESCRIBES, passes } from "./passes";
import type { Priced, Shortcut } from "./pull";
import type { QuadNode, QuadTree } from "./quadtree";

/**
 * The fallback search (plan §4.1 step 8): when no route passes, the lowest
 * risk-weighted route through charted water. A square the check fails or cannot verify
 * may be crossed, at a cost per metre that grows with its P(UKC < 0), so the route
 * trades distance for risk; land, water with no chart and water the chart was never
 * asked about are never crossed, and neither is a square whose verdict carries a flag
 * this list does not know, so a hard rule underkeel reports later stays closed. The route check still decides every leg's status, so the legs over
 * such water come back `fail`, `marginal` or `unverified`, marked as they are.
 */

/** Per-metre cost of crossing a square at P(UKC < 0) = 1. */
export const RISK_WEIGHT = 1000;
/** Per-metre cost of crossing a square the check cannot verify, on top of its risk. */
export const UNVERIFIED_WEIGHT = 100;

/**
 * The only flags the fallback crosses: they say how the depth was charted or how the
 * water level was taken, not that the water is closed. Any other flag closes the square:
 * `LAND`, `LAND_CROSSED` (a leg's own line over land), `NO_COVERAGE`, `BOX_TOO_LARGE` (never
 * queried), `TOO_LONG_FOR_ONE_LEG` (never checked) and any flag not listed here, such as an entry-prohibited area (`ENTRY_PROHIBITED`),
 * a traffic lane crossed the wrong way (`TSS_WRONG_WAY`, AGENTS.md invariant 4), or a bridge
 * or overhead cable too low for the boat or of unknown clearance (`AIR_DRAFT`,
 * `CLEARANCE_UNKNOWN`).
 */
const CROSSABLE = new Set([
  "UNASSESSED",
  "NOT_FOR_NAVIGATION",
  "WATER_LEVEL_FALLBACK",
  // Named by the route check and changing no status (`passes.ts`): swept or dredged water, a
  // leg held to a fairway gap's strip under a bridge, a traffic lane, which a leg is held to
  // when it crosses it, restricted areas that only ask for care, and a clearance passed on the
  // rise signalk-underkeel allows where it cannot relate it to the water level.
  ...DESCRIBES
]);

/** True when the fallback may cross water with this verdict. */
export function crossable(v: Pick<Verdict, "flags">): boolean {
  return v.flags.every((f) => CROSSABLE.has(f));
}

/**
 * True when a berth leg may carry this verdict: it lies alongside the quay, so `LAND` is
 * expected, but any other flag the fallback may not cross (no chart, a hard rule) closes it.
 * So does `LAND_CROSSED`, signalk-underkeel's flag of a leg whose own line lies over land past
 * the land at its ends: a berth leg leaves its quay, it does not go through a breakwater.
 */
export function berthable(v: Pick<Verdict, "flags">): boolean {
  return v.flags.every((f) => f === "LAND" || CROSSABLE.has(f));
}

/**
 * The risk cost (plan §4.4): a route's cost per metre grows by `weight` · P / `threshold`, P
 * the square's P(UKC < 0) and `threshold` the request's accepted probability, so a route with
 * a weight keeps away from the margin. Weight 0 is the shortest route.
 */
export interface RiskCost {
  weight: number;
  threshold: number;
}

/** A leaf's added cost per metre under `cost`; 0 without one. */
export function riskCost(n: QuadNode, cost?: RiskCost): number {
  return cost ? (cost.weight * (n.verdict?.risk ?? 0)) / cost.threshold : 0;
}

/** Per-metre cost of a leaf in the fallback search; Infinity where it may not go. */
export function fallbackWeight(n: QuadNode, cost?: RiskCost): number {
  if (n.state === "free") {
    return 1 + riskCost(n, cost);
  }
  const v = n.verdict;
  if (
    (n.state !== "blocked" && n.state !== "unverified" && n.state !== "marginal") ||
    !v ||
    !crossable(v)
  ) {
    return Infinity;
  }
  return (
    1 +
    RISK_WEIGHT * v.risk +
    (v.status === "unverified" ? UNVERIFIED_WEIGHT : 0) +
    riskCost(n, cost)
  );
}

/**
 * Per-metre cost of a leaf in the strict search: free water 1; a smallest square the check
 * marks marginal, which a strict plan accepts, at the same risk cost as the fallback, so the
 * route crosses as little of it as it can, unless its flags close it (`crossable`); Infinity
 * elsewhere. Each with its risk cost under `cost`.
 */
export function strictWeight(n: QuadNode, cost?: RiskCost): number {
  if (n.state === "free") {
    return 1 + riskCost(n, cost);
  }
  return n.state === "marginal" && n.verdict && crossable(n.verdict)
    ? 1 + RISK_WEIGHT * n.verdict.risk + riskCost(n, cost)
    : Infinity;
}

/**
 * A shortcut that does not pass may replace path points i..j only when every piece of
 * the path between them already crosses a square the check does not pass, `allowed`
 * takes the shortcut's verdict (the fallback: only flags it may cross, so never land,
 * uncharted water or a leg too long to check; the strict search: marginal), and it is no
 * riskier than the riskiest of those squares: pulling
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
    // A search piece runs within one square, from its entry to its centre and on; a piece
    // that leaves it, such as a checked leg joining an end, passed its own check, so it is
    // not risky, and nor is a free square's piece, whatever its verdict's own risk.
    const inside = (x: number, y: number): boolean =>
      !!leaf &&
      x >= leaf.x - 1e-6 &&
      x <= leaf.x + leaf.size + 1e-6 &&
      y >= leaf.y - 1e-6 &&
      y <= leaf.y + leaf.size + 1e-6;
    if (!leaf || leaf.state === "free" || !inside(ax, ay) || !inside(bx, by)) {
      return undefined;
    }
    return leaf.verdict?.risk ?? 0;
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

/**
 * Per-metre cost of a leg with verdict `v`, as the search would price water with that verdict:
 * passing water at its risk cost; the strict search's marginal water, or the fallback's
 * crossable water, at the fallback's risk weight too; Infinity where neither may go.
 */
export function verdictWeight(
  v: Verdict,
  rule: PassRule,
  how: { fallback: boolean; cost?: RiskCost }
): number {
  const extra = how.cost ? (how.cost.weight * v.risk) / how.cost.threshold : 0;
  if (passes(v, rule)) {
    return 1 + extra;
  }
  const may = how.fallback ? crossable(v) : v.status === "marginal" && crossable(v);
  if (!may) {
    return Infinity;
  }
  return 1 + RISK_WEIGHT * v.risk + (v.status === "unverified" ? UNVERIFIED_WEIGHT : 0) + extra;
}

/**
 * With a risk cost or preference lines, a shortcut may replace path points i..j only when,
 * priced at its own verdict (`verdictWeight`; a leg's risk is its worst point, so the price is pessimistic), it
 * costs no more than the path between them at its squares' weights, and of those the one whose
 * cost with the path's on to its end is lowest: pulling straightens the route the search found
 * without undoing what it paid to keep from the margin. A piece whose
 * square the search's weight does not price, such as a checked leg joining an end, is priced
 * as free water at its square's risk.
 */
export function costShortcut(
  tree: QuadTree,
  path: readonly LonLat[],
  weight: (n: QuadNode) => number,
  priced: (v: Verdict, a: LonLat, b: LonLat) => number,
  cost?: RiskCost
): Priced {
  const sums = [0];
  path.slice(1).forEach((b, k) => {
    const a = path[k] as LonLat;
    const [ax, ay] = tree.units(a);
    const [bx, by] = tree.units(b);
    const leaf = tree.leafAt((ax + bx) / 2, (ay + by) / 2);
    const w = leaf ? weight(leaf) : Infinity;
    const per = Number.isFinite(w) ? w : 1 + (leaf ? riskCost(leaf, cost) : 0);
    sums.push((sums[k] as number) + haversine(a, b) * per);
  });
  const total = sums[sums.length - 1] as number;
  const own = (v: Verdict, i: number, j: number): number => {
    const a = path[i] as LonLat;
    const b = path[j] as LonLat;
    return haversine(a, b) * priced(v, a, b);
  };
  return {
    accept: (v, i, j) => own(v, i, j) <= (sums[j] as number) - (sums[i] as number) + 1e-6,
    score: (v, i, j) => own(v, i, j) + total - (sums[j] as number)
  };
}
