import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { QuadTree } from "../search/quadtree";
import { centre } from "../search/quadtree";
import type { PlanOptions } from "./options";
import type { Mode, Stuck } from "./search";

/**
 * Where a harbour stage may hand over (plan §4.1, harbour stage): free water near an end the
 * search could not join.
 */

/**
 * Squares near `p`, within `harbourMetres`, that `mode` may enter, as their centres: where a
 * harbour stage from an end the corridor cannot reach may hand over. Of those not much farther
 * than the nearest, the ones most on the way come first, by the distance from `p` plus the
 * distance on to the other end, `other`, so the route does not double back from the nearest.
 */
function handovers(
  tree: QuadTree,
  p: LonLat,
  other: LonLat,
  opts: PlanOptions,
  mode: Mode & { exhausted: () => boolean }
): LonLat[] | "work" {
  const [ux, uy] = tree.units(p);
  const r = opts.harbourMetres / tree.shape.unit;
  const leaves = tree.leaves(
    (n) => n.x < ux + r && ux - r < n.x + n.size && n.y < uy + r && uy - r < n.y + n.size,
    mode.exhausted
  );
  // The enumeration stops at the search's share of the work, and the search with it.
  if (mode.exhausted()) {
    return "work";
  }
  return leaves
    .filter((n) => mode.enter(n))
    .map((n) => {
      const c = centre(n);
      const cl = tree.lonLat(c[0], c[1]);
      return { cl, d: haversine(p, cl), on: haversine(p, cl) + haversine(cl, other) };
    })
    .filter((x) => x.d <= opts.harbourMetres)
    .sort((a, b) => a.d - b.d)
    .filter((x, _, all) => x.d <= nearby((all[0] as { d: number }).d))
    .sort((a, b) => a.on - b.on)
    .slice(0, 6)
    .map((x) => x.cl);
}

/** Handovers not much farther than the nearest: a harbour stage costs about its region's area. */
const nearby = (nearest: number): number => Math.max(1.5 * nearest, nearest + 300);

/** Handover candidates for each end a failed attempt could not join, when there are any. */
export function stuckEnds(
  tree: QuadTree,
  ends: [LonLat, LonLat],
  failed: { start: boolean; end: boolean } | undefined,
  opts: PlanOptions,
  mode: Mode & { exhausted: () => boolean }
): Stuck | "work" | undefined {
  if (!failed || opts.harbourMetres <= 0) {
    return undefined;
  }
  const start = failed.start ? handovers(tree, ends[0], ends[1], opts, mode) : [];
  const end = failed.end ? handovers(tree, ends[1], ends[0], opts, mode) : [];
  if (start === "work" || end === "work") {
    return "work";
  }
  // A harbour stage needs somewhere to hand over at every end the search could not join.
  if ((failed.start && start.length === 0) || (failed.end && end.length === 0)) {
    return undefined;
  }
  return { ...(failed.start && { start }), ...(failed.end && { end }) };
}
