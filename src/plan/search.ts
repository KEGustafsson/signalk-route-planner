import type { LonLat } from "../foundation/geo";
import { frameAt, haversine, midpoint } from "../foundation/geo";
import type { Session, Verdict } from "../oracle/contract";
import { aStar } from "../search/astar";
import { pull } from "../search/pull";
import type { QuadNode, TreeShape } from "../search/quadtree";
import { centre, QuadTree } from "../search/quadtree";
import type { PlanOptions } from "./options";

/**
 * The static search (plan §4.1): the direct line first, then a quadtree over the
 * region, A* through its free squares and string pulling. Every point it
 * returns is a suggestion for the proof step; the route check decides.
 */

export type SearchOutcome =
  | { ok: true; coordinates: LonLat[]; direct: Verdict; squares: number; work: number }
  | {
      ok: false;
      reason: string;
      direct: Verdict;
      squares: number;
      /** One-unit squares the check could not verify that the search met. */
      unverified: number;
      work: number;
    };

/** A box with its corridor buffer stays under the planning API's 25 km² (24 km² here). */
const MAX_BOX_SIDE = Math.sqrt(24e6);

const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** The quadtree's shape around start and goal, or why there is none. */
export function shapeFor(
  from: LonLat,
  to: LonLat,
  halfWidth: number,
  opts: PlanOptions
): TreeShape | string {
  const d = haversine(from, to);
  const half = d / 2 + Math.max(d / 2, opts.minMargin);
  let unit = Math.max(opts.minCell, halfWidth / 2);
  while (pow2((2 * half) / unit) > opts.maxSideUnits) {
    unit *= 2;
  }
  const side = pow2((2 * half) / unit);
  const leafMetres = Math.min(opts.maxLeafMetres, MAX_BOX_SIDE - 2 * halfWidth);
  if (leafMetres < unit) {
    return `the corridor half-width ${Math.round(halfWidth)} m is too wide to plan in`;
  }
  const maxLeaf = 2 ** Math.floor(Math.log2(leafMetres / unit));
  const extent = (side * unit) / 2;
  return { frame: frameAt(midpoint(from, to)), x0: -extent, y0: -extent, unit, side, maxLeaf };
}

interface Access {
  leaf: QuadNode;
  /** Where the search starts or ends in the leaf, unit coordinates. */
  at: [number, number];
  /** The start or goal point itself, when it joins the leaf by a checked leg. */
  joined?: LonLat;
}

/**
 * The free square the search leaves from or arrives at for point `p`: the one
 * holding it, or the nearest free square within `accessMetres` whose centre a
 * leg from `p` (to `p`, for the goal) reaches with an `ok` check.
 */
function access(
  tree: QuadTree,
  session: Session,
  p: LonLat,
  goal: boolean,
  opts: PlanOptions
): Access | string {
  const [ux, uy] = tree.units(p);
  const own = tree.leafAt(ux, uy);
  if (own?.state === "free") {
    return { leaf: own, at: [ux, uy] };
  }
  const r = opts.accessMetres / tree.shape.unit;
  const near = tree
    .leaves((n) => n.x < ux + r && ux - r < n.x + n.size && n.y < uy + r && uy - r < n.y + n.size)
    .filter((n) => n.state === "free")
    .map((n) => ({ n, d: Math.hypot(centre(n)[0] - ux, centre(n)[1] - uy) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  for (const { n } of near) {
    const c = centre(n);
    const cl = tree.lonLat(c[0], c[1]);
    if ((goal ? session.segment(cl, p) : session.segment(p, cl)).status === "ok") {
      return { leaf: n, at: c, joined: p };
    }
  }
  const what = goal ? "destination" : "start";
  const flags = own?.verdict?.flags.length ? ` (${own.verdict.flags.join(", ")})` : "";
  return `no water the route check passes within ${opts.accessMetres} m of the ${what}${flags}`;
}

export async function searchRoute(
  session: Session,
  from: LonLat,
  to: LonLat,
  opts: PlanOptions
): Promise<SearchOutcome> {
  const direct = session.segment(from, to);
  if (direct.status === "ok") {
    return { ok: true, coordinates: [from, to], direct, squares: 0, work: session.work() };
  }
  const shape = shapeFor(from, to, session.halfWidth, opts);
  const tree = typeof shape === "string" ? undefined : new QuadTree(shape, session);
  const refuse = (reason: string): SearchOutcome => ({
    ok: false,
    reason,
    direct,
    squares: tree?.classified ?? 0,
    unverified: tree?.unverified ?? 0,
    work: session.work()
  });
  if (!tree) {
    return refuse(shape as string);
  }
  const start = access(tree, session, from, false, opts);
  const goal = typeof start === "string" ? start : access(tree, session, to, true, opts);
  if (typeof start === "string" || typeof goal === "string") {
    return refuse(typeof start === "string" ? start : (goal as string));
  }
  const searchWork = opts.maxWork * opts.searchShare;
  const found =
    start.leaf === goal.leaf
      ? { found: true as const, points: [start.at, goal.at] }
      : await aStar(tree, start.leaf, start.at, goal.leaf, goal.at, {
          exhausted: () => session.work() >= searchWork,
          pause: () => session.pause(),
          every: 64
        });
  if (!found.found) {
    return refuse(
      found.reason === "work"
        ? "the search reached its work limit; plan a shorter passage or add a waypoint between"
        : tree.unverified > 0
          ? "no route the check passes connects the points; the search met water the check cannot verify (no chart coverage or unassessed survey), which a route may need"
          : "no route the check passes connects the points: land, shoals or obstacles close every way"
    );
  }
  const path = [
    ...(start.joined ? [start.joined] : []),
    ...found.points.map(([x, y]) => tree.lonLat(x, y)),
    ...(goal.joined ? [goal.joined] : [])
  ];
  const coordinates = await pull(path, (a, b) => session.segment(a, b), {
    exhausted: () => session.work() >= opts.maxWork,
    pause: () => session.pause()
  });
  return { ok: true, coordinates, direct, squares: tree.classified, work: session.work() };
}
