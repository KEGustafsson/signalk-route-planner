import type { LonLat } from "../foundation/geo";
import { EARTH_RADIUS, haversine } from "../foundation/geo";
import type { QuadNode, QuadTree } from "../search/quadtree";
import { centre } from "../search/quadtree";
import type { PlanOptions } from "./options";
import type { Mode, Stuck } from "./search";

/**
 * Where a harbour stage may hand over (plan §4.1, harbour stage): free water near an end the
 * search could not join, chosen best first within the search's share of the work.
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
  const within =
    (metres: number) =>
    (n: QuadNode): boolean => {
      const c = centre(n);
      return haversine(p, tree.lonLat(c[0], c[1])) <= metres;
    };
  // Best first, as `access`: only squares nearer than the candidates are classified, and
  // the query stops at the search's share of the work, the search with it. Only usable
  // handovers count, so one whose centre is out of range does not crowd out a nearer one.
  const [first] = tree.nearest(
    ux,
    uy,
    reach(tree, p, opts.harbourMetres),
    (n) => mode.enter(n) && within(opts.harbourMetres)(n),
    1,
    mode.exhausted
  );
  if (mode.exhausted()) {
    return "work";
  }
  if (!first) {
    return [];
  }
  const fc = centre(first);
  const metres = Math.min(opts.harbourMetres, nearby(haversine(p, tree.lonLat(fc[0], fc[1]))));
  // Of those not much farther than the nearest, the ones most on the way to `other` first:
  // the query orders squares by the way through them, so a handover on the way is ranked
  // before any cap on the candidates leaves it out.
  const found = tree.nearest(
    ux,
    uy,
    reach(tree, p, metres),
    (n) => mode.enter(n) && within(metres)(n),
    2 * HANDOVERS,
    mode.exhausted,
    tree.units(other)
  );
  if (mode.exhausted()) {
    return "work";
  }
  return found
    .map((n) => {
      const c = centre(n);
      const cl = tree.lonLat(c[0], c[1]);
      return { cl, on: haversine(p, cl) + haversine(cl, other) };
    })
    .sort((x, y) => x.on - y.on)
    .slice(0, HANDOVERS)
    .map((x) => x.cl);
}

/** Handovers a harbour stage is offered, most on the way first. */
const HANDOVERS = 6;

/**
 * The query radius, units, that holds every square whose centre is within `metres` of `p`:
 * the frame measures east–west at its origin's latitude, which overstates distances
 * poleward of it, so the radius grows by that ratio at the most poleward latitude reached
 * (and a little more for the sphere against the plane).
 */
function reach(tree: QuadTree, p: LonLat, metres: number): number {
  const DEG = Math.PI / 180;
  const origin = tree.shape.frame.origin[1];
  const lat = Math.min(89, Math.abs(p[1]) + metres / (EARTH_RADIUS * DEG));
  const k = Math.max(1, Math.cos(origin * DEG) / Math.cos(lat * DEG));
  return (metres / tree.shape.unit) * k * 1.001;
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
