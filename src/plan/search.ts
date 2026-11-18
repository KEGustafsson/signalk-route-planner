import type { LonLat } from "../foundation/geo";
import { frameAt, haversine, midpoint } from "../foundation/geo";
import type { Session, Verdict } from "../oracle/contract";
import { aStar } from "../search/astar";
import type { PassRule } from "../search/passes";
import { OK_ONLY, passes } from "../search/passes";
import { crossable, fallbackWeight } from "../search/fallback";
import type { Shortcut } from "../search/pull";
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
  | {
      ok: true;
      coordinates: LonLat[];
      direct: Verdict;
      squares: number;
      work: number;
      /** Set when no route passed and this is the least risky one: why none passed. */
      fallback?: string;
    }
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

/** Legs whose corridor is over this, km², are never checked as one leg (the API refuses 25). */
const MAX_LEG_KM2 = 24;

const NOT_CHECKED: Verdict = { status: "unverified", risk: 0, flags: ["TOO_LONG_FOR_ONE_LEG"] };

/**
 * The leg a → b checked through the session, or NOT_CHECKED when its corridor (length plus
 * both ends, times twice the half-width) is over MAX_LEG_KM2: the planning API throws on those.
 */
export function checkLeg(session: Session, a: LonLat, b: LonLat): Verdict {
  const r = session.halfWidth;
  return ((haversine(a, b) + 2 * r) * 2 * r) / 1e6 > MAX_LEG_KM2
    ? NOT_CHECKED
    : session.segment(a, b);
}

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

/** What a search may cross: strictly passing water, or for the fallback, charted water at a cost. */
interface Mode {
  enter(n: QuadNode): boolean;
  /** True when a checked leg may join the start or goal to a square. */
  joins(v: Verdict): boolean;
  weight?(n: QuadNode): number;
}

const strictMode = (rule: PassRule): Mode => ({
  enter: (n) => n.state === "free",
  joins: (v) => passes(v, rule)
});

const FALLBACK: Mode = {
  enter: (n) => Number.isFinite(fallbackWeight(n)),
  joins: (v) => crossable(v),
  weight: fallbackWeight
};

/**
 * The square the search leaves from or arrives at for point `p`: the one holding
 * it, or the nearest within `accessMetres` whose centre a checked leg from `p` (to
 * `p`, for the goal) joins.
 */
function access(
  tree: QuadTree,
  session: Session,
  p: LonLat,
  goal: boolean,
  opts: PlanOptions,
  mode: Mode
): Access | string {
  const [ux, uy] = tree.units(p);
  const own = tree.leafAt(ux, uy);
  if (own && mode.enter(own)) {
    return { leaf: own, at: [ux, uy] };
  }
  const r = opts.accessMetres / tree.shape.unit;
  const near = tree
    .leaves((n) => n.x < ux + r && ux - r < n.x + n.size && n.y < uy + r && uy - r < n.y + n.size)
    .filter((n) => mode.enter(n))
    .map((n) => ({ n, d: Math.hypot(centre(n)[0] - ux, centre(n)[1] - uy) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  for (const { n } of near) {
    const c = centre(n);
    const cl = tree.lonLat(c[0], c[1]);
    if (mode.joins(goal ? checkLeg(session, cl, p) : checkLeg(session, p, cl))) {
      return { leaf: n, at: c, joined: p };
    }
  }
  const what = goal ? "destination" : "start";
  const flags = own?.verdict?.flags.length ? ` (${own.verdict.flags.join(", ")})` : "";
  return `no water the route check passes within ${opts.accessMetres} m of the ${what}${flags}`;
}

type Attempt = { path: LonLat[] } | { reason: string };

/** One search from `from` to `to` in `mode`: the raw path, or why there is none. */
async function attempt(
  tree: QuadTree,
  session: Session,
  ends: [LonLat, LonLat],
  opts: PlanOptions,
  mode: Mode
): Promise<Attempt> {
  const start = access(tree, session, ends[0], false, opts, mode);
  const goal = typeof start === "string" ? start : access(tree, session, ends[1], true, opts, mode);
  if (typeof start === "string" || typeof goal === "string") {
    return { reason: typeof start === "string" ? start : (goal as string) };
  }
  const searchWork = opts.maxWork * opts.searchShare;
  const found =
    start.leaf === goal.leaf
      ? { found: true as const, points: [start.at, goal.at] }
      : await aStar(tree, start.leaf, start.at, goal.leaf, goal.at, {
          exhausted: () => session.work() >= searchWork,
          pause: () => session.pause(),
          every: 64,
          weight: mode.weight
        });
  if (!found.found) {
    return {
      reason:
        found.reason === "work"
          ? WORK_LIMIT
          : tree.unverified > 0
            ? "no route the check passes connects the points; the search met water the check cannot verify (no chart coverage or unassessed survey), which a route may need"
            : "no route the check passes connects the points: land, shoals or obstacles close every way"
    };
  }
  return {
    path: [
      ...(start.joined ? [start.joined] : []),
      ...found.points.map(([x, y]) => tree.lonLat(x, y)),
      ...(goal.joined ? [goal.joined] : [])
    ]
  };
}

const WORK_LIMIT =
  "the search reached its work limit; plan a shorter passage or add a waypoint between";

/**
 * A fallback shortcut that does not pass may replace path points i..j only when every
 * piece of the path between them already crosses a square the check does not pass,
 * the shortcut crosses no land or uncharted water, and it is no riskier than the
 * riskiest of those squares: pulling straightens a risky stretch within itself and
 * never draws passing water into it.
 */
function fallbackShortcut(tree: QuadTree, path: readonly LonLat[]): Shortcut {
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
      span.every((r) => r !== undefined) &&
      v.risk <= Math.max(...(span as number[]))
    );
  };
}

export async function searchRoute(
  session: Session,
  from: LonLat,
  to: LonLat,
  opts: PlanOptions,
  rule: PassRule = OK_ONLY,
  fallback = false
): Promise<SearchOutcome> {
  const direct = checkLeg(session, from, to);
  if (passes(direct, rule)) {
    return { ok: true, coordinates: [from, to], direct, squares: 0, work: session.work() };
  }
  const shape = shapeFor(from, to, session.halfWidth, opts);
  const tree = typeof shape === "string" ? undefined : new QuadTree(shape, session, rule);
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
  const strict = await attempt(tree, session, [from, to], opts, strictMode(rule));
  const again =
    "reason" in strict && fallback && strict.reason !== WORK_LIMIT
      ? await attempt(tree, session, [from, to], opts, FALLBACK)
      : undefined;
  const found = again && "path" in again ? again : strict;
  if (!("path" in found)) {
    return refuse((strict as { reason: string }).reason);
  }
  const coordinates = await pull(
    found.path,
    (a, b) => checkLeg(session, a, b),
    { exhausted: () => session.work() >= opts.maxWork, pause: () => session.pause() },
    rule,
    found === strict ? undefined : fallbackShortcut(tree, found.path)
  );
  return {
    ok: true,
    coordinates,
    direct,
    squares: tree.classified,
    work: session.work(),
    ...(found !== strict && { fallback: (strict as { reason: string }).reason })
  };
}
