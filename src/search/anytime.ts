import type { SearchResult } from "./astar";
import type { QuadNode, QuadTree } from "./quadtree";

type XY = [number, number];

/** A second path is kept only when it saves at least this share of the first's cost. */
const MIN_GAIN = 1e-3;

/**
 * A path as the search priced it: each piece's length at the weight of the square it crosses,
 * 1 where the square carries none, and the length of it in squares that are not free (marginal
 * water, or the fallback's). Pieces run within one square, so its midpoint names it.
 */
export function pathCost(
  tree: QuadTree,
  points: readonly XY[],
  weight?: (n: QuadNode) => number
): { cost: number; risky: number } {
  let cost = 0;
  let risky = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as XY;
    const b = points[k] as XY;
    const leaf = tree.leafAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    const w = leaf && weight ? weight(leaf) : 1;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    cost += d * (Number.isFinite(w) ? w : 1);
    risky += leaf && leaf.state !== "free" ? d : 0;
  }
  return { cost, risky };
}

/**
 * The search at `greed`, and when that is above `fine`, again at `fine` over the squares the
 * first already classified: weighted A* may pass the shortest way by for one up to `greed` times
 * longer. The second is kept only when it is cheaper by at least `MIN_GAIN` and crosses no more
 * water that is not free, so a shorter way is never bought with risk and a gain within the
 * pieces' rounding never moves the route. Out of work, the first stands.
 */
export async function cheapest(
  tree: QuadTree,
  search: (greed: number) => Promise<SearchResult>,
  greed: { first: number; fine: number },
  weight?: (n: QuadNode) => number
): Promise<SearchResult> {
  const found = await search(greed.first);
  if (!found.found || greed.first <= greed.fine) {
    return found;
  }
  const fine = await search(greed.fine);
  if (!fine.found) {
    return found;
  }
  const a = pathCost(tree, found.points, weight);
  const b = pathCost(tree, fine.points, weight);
  return b.cost <= a.cost * (1 - MIN_GAIN) && b.risky <= a.risky + 1e-9 ? fine : found;
}
